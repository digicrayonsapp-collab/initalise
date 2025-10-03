const express = require("express");
const helmet = require("helmet");
const { httpLogger, log } = require("./core/logger");
const { AppError, toAppError } = require("./core/errors");
const { initSQLite, markJob, setKV } = require("./infra/sqlite"); // ⬅️ added setKV
const { tickRunner } = require("./infra/scheduler");
const routes = require("./api/routes");
const { get } = require("./config/env");
const { DateTime } = require("luxon");

const { getAzureAccessToken } = require("./services/graphAuth");
const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  getDeletedUser,
  revokeUserSessions,
  deleteUser,
  updateUser, // already used elsewhere; fine to keep
} = require("./services/graphUser");
const {
  officialEmailFromUpn,
  updateCandidateOfficialEmail,
} = require("./services/zohoPeople");

function mask(s) {
  if (!s) return "MISSING";
  s = String(s);
  return s.length <= 6 ? "***" : `${s.slice(0, 3)}…${s.slice(-3)}`;
}
console.log(
  "🔧 Azure env:",
  "tenant=",
  mask(process.env.AZURE_TENANT_ID),
  "clientId=",
  mask(process.env.AZURE_CLIENT_ID),
  "secretSet=",
  !!process.env.AZURE_CLIENT_SECRET
);

// in src/index.js
async function executor(job) {
  // Always parse payload
  const payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;

  // Common banner
  const rawType = job.type;
  const type = String(rawType || "").trim().toLowerCase();
  const tz = process.env.TZ || "Asia/Kolkata";
  const nowUtc = new Date().toISOString();
  const nowIst = DateTime.now().setZone(tz).toFormat("dd-LL-yyyy HH:mm:ss ZZZZ");
  log.info(`🚀 Running job ${job.id} [${job.type}] for candidate ${payload?.candidateId ?? "n/a"} at UTC=${nowUtc} / ${tz}=${nowIst}`);

  // For "create" or "createFromCandidate" type jobs
  if (type === "create" || type === "createfromcandidate") {
    try {
      const {
        firstname, lastname, email, employeeId, domain, candidateId,
        country, city, mobilePhone, department, zohoRole, company,
        employementType, employeeType, officelocation, joiningdate,
      } = payload;

      log.info(`🔧 Upsert for candidateId=${candidateId ?? "n/a"} firstname=${firstname} lastname=${lastname}`);

      // Token
      log.info('🔑 [create] Getting Azure token…');
      const token = await getAzureAccessToken();
      log.info('✅ [create] Azure token OK');

      // Check if the user already exists in Azure by employeeId, email, or UPN
      let userExists = false;
      let existingUser = null;

      try {
        // Check by employeeId first
        existingUser = await findByEmployeeId(token, employeeId);
        if (existingUser) {
          userExists = true;
          log.info(`✅ [create] User already exists in Azure with employeeId=${employeeId}`);
        }
      } catch (error) {
        log.warn("⚠️ [create] User lookup failed:", error.message);
      }

      if (!userExists && email) {
        try {
          // Fallback check by email
          existingUser = await findByEmail(token, email);
          if (existingUser) {
            userExists = true;
            log.info(`✅ [create] User already exists in Azure with email=${email}`);
          }
        } catch (error) {
          log.warn("⚠️ [create] Email lookup failed:", error.message);
        }
      }

      if (userExists) {
        // If the user exists, skip the creation and mark the job as done
        log.info("ℹ️ [create] Skipping user creation as user already exists.");

        // ✅ start a short cool-down so any echo webhook right now won't re-schedule
        try {
          if (candidateId) {
            const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || "3", 10);
            const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
            setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
          }
        } catch (e) {
          log.warn("⚠️ [create] Failed to set cooldown:", e?.message || e);
        }

        // Mark job as done (optionally include a result)
        markJob(job.id, {
          status: "done",
          result: {
            action: "already_exists",
            userId: existingUser?.id || null,
            upn: existingUser?.userPrincipalName || null,
          },
        });
        return; // Exit the job if user exists
      }

      // Continue with user creation if user doesn't exist
      let effectiveEmployeeId = employeeId;

      // Employee ID generation (fallback to Graph scan)
      if (!effectiveEmployeeId) {
        try {
          const { getLastEmployeeIdFromZoho } = require("./services/zohoPeople");
          const last = await getLastEmployeeIdFromZoho();
          if (Number.isFinite(last)) {
            const next = last + 1;
            effectiveEmployeeId = String(next);
            const { setKV } = require("./infra/sqlite");
            setKV('EMPLOYEE_ID_SEQ', next);
            log.info(`🆔 [create] From Zoho: ${last} → ${next}`);
          }
        } catch (e) {
          log.warn("⚠️ [create] Zoho last Employee_ID fetch failed:", e?.response?.data || e?.message || e);
        }
      }

      if (!effectiveEmployeeId) {
        try {
          const { bumpKVInt, getKVInt } = require("./infra/sqlite");
          const prev = getKVInt('EMPLOYEE_ID_SEQ', 0);
          if (prev > 0) {
            const next = bumpKVInt('EMPLOYEE_ID_SEQ');
            effectiveEmployeeId = String(next);
            log.warn(`⚠️ 🆔 [cache] Using cached sequence: ${prev} → ${next} (Zoho unavailable)`);
          }
        } catch (e) {
          log.warn("⚠️ [create] KV fallback failed:", e?.message || e);
        }
      }

      if (!effectiveEmployeeId) {
        try {
          const { getNextEmployeeId } = require("./services/graphUser"); // scans Graph users
          const next = await getNextEmployeeId(token);
          effectiveEmployeeId = String(next);
          const n = parseInt(next, 10);
          if (Number.isFinite(n)) {
            const { setKV } = require("./infra/sqlite");
            setKV('EMPLOYEE_ID_SEQ', n);
          }
          log.info(`🆔 [create] From Azure scan: ${next}`);
        } catch (e) {
          log.warn("⚠️ [create] Azure scan for next employeeId failed:", e?.response?.data || e?.message || e);
        }
      }

      // ✅ define empType and pass it to upsertUser
      const empType = employeeType || employementType || null;

      const { upsertUser, updateUser } = require("./services/graphUser");
      const result = await upsertUser(token, {
        firstname, lastname, email,
        employeeId: effectiveEmployeeId,
        domain,
        country, city, mobilePhone, department, zohoRole, company,
        employeeType: empType,        // correct key
        employementType: empType,     // keep legacy in sync
        officelocation,
      });
      log.info(`✅ [create] Azure ${result.action}: id=${result.userId}, upn=${result.upn}`);

      // Optional hire date
      if (joiningdate) {
        try {
          const [dd, mm, yyyy] = String(joiningdate).split("-");
          const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
          if (!isNaN(dt.getTime())) {
            await updateUser(token, result.userId, { employeeHireDate: dt.toISOString().replace(/\.\d{3}Z$/, "Z") });
            log.info("✅ [create] employeeHireDate set");
          }
        } catch (e) {
          log.warn("⚠️ [create] Failed to set employeeHireDate:", e.message);
        }
      }

      // Push Official Email & Employee ID back to Zoho (using helpers you already have)
      if (candidateId) {
        try {
          const official = officialEmailFromUpn(result.upn);
          const officialField = process.env.OFFICIAL_EMAIL_FIELD_LINK_NAME || 'Other_Email';
          const empIdField = process.env.ZOHO_EMPLOYEEID_FIELD_LINK_NAME || 'Employee_ID';

          const { updateCandidateFields } = require("./services/zohoPeople");
          const fields = { [officialField]: official };
          if (effectiveEmployeeId) fields[empIdField] = String(effectiveEmployeeId);

          await updateCandidateFields({ recordId: candidateId, fields });
          log.info("✅ [create] Zoho Candidate updated with Official Email & Employee ID");
        } catch (zerr) {
          log.warn("⚠️ [create] Zoho update failed:", zerr?.response?.data || zerr?.message || zerr);
        }
      }

      // ===== SUCCESS BOOKKEEPING + COOL-DOWN =====
      try {
        // start a short cool-down to suppress any immediate webhook echo
        if (candidateId) {
          const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || "3", 10);
          const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
          setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
        }

        markJob(job.id, {
          status: "done",
          result: { userId: result.userId, upn: result.upn, action: result.action },
        });
      } catch {
        markJob(job.id, { status: "done" });
      }
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error('❌ [create] Failed:', details);
      markJob(job.id, { status: "failed", lastError: details });
      return;
    }
  }
  if (type === "deleteuser") {
    const { employeeId, email, upn } = (typeof payload === "string" ? JSON.parse(payload) : payload) || {};
    const nowUtc2 = DateTime.utc().toISO();
    const nowIst2 = DateTime.now().setZone(tz).toFormat("dd-LL-yyyy HH:mm:ss ZZZZ");
    log.info(`🗑️ [deleteUser] Start UTC=${nowUtc2} / ${tz}=${nowIst2}`);
    log.info("🧩 [deleteUser] Payload:", { employeeId, email, upn });

    try {
      log.info("🔑 [deleteUser] Fetching Azure token…");
      const token = await getAzureAccessToken();
      log.info("✅ [deleteUser] Azure token OK");

      // Lookups: employeeId first, then email/UPN (verify employeeId if provided)
      log.info(`🔎 [deleteUser] Lookup by employeeId="${employeeId}"…`);
      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;

      if (!user && email) {
        log.info(`🔎 [deleteUser] Fallback by email="${email}" (verify employeeId)…`);
        const byEmail = await findByEmail(token, String(email).trim());
        if (byEmail && (!employeeId || String(byEmail.employeeId ?? "").trim() === String(employeeId).trim())) {
          user = byEmail;
          log.info("✅ [deleteUser] Email matched" + (employeeId ? " and employeeId verified" : ""));
        } else if (byEmail) {
          log.warn("⛔ [deleteUser] Email matched but employeeId mismatch", {
            azureEmployeeId: String(byEmail.employeeId ?? "").trim(),
            zohoEmployeeId: String(employeeId ?? "").trim(),
          });
        }
      }

      if (!user && upn) {
        log.info(`🔎 [deleteUser] Fallback by UPN="${upn}" (verify employeeId)…`);
        const byUpn = await findUserByUPN(token, String(upn).trim());
        if (byUpn && (!employeeId || String(byUpn.employeeId ?? "").trim() === String(employeeId).trim())) {
          user = byUpn;
          log.info("✅ [deleteUser] UPN matched" + (employeeId ? " and employeeId verified" : ""));
        } else if (byUpn) {
          log.warn("⛔ [deleteUser] UPN matched but employeeId mismatch", {
            azureEmployeeId: String(byUpn.employeeId ?? "").trim(),
            zohoEmployeeId: String(employeeId ?? "").trim(),
          });
        }
      }

      if (!user) {
        log.warn("⚠️ [deleteUser] User not found with matching criteria");
        markJob(job.id, { status: "failed", lastError: "User not found for delete" });
        return;
      }

      // Optional read-before
      try {
        const before = await getUser(token, user.id, "id,userPrincipalName,employeeId,accountEnabled");
        log.info(`[deleteUser] Before delete: upn=${before?.userPrincipalName}, empId=${before?.employeeId}, enabled=${String(before?.accountEnabled)}`);
      } catch (e) {
        log.warn("[deleteUser] Read-before failed:", e?.response?.data || e?.message || e);
      }

      // Revoke sessions (best-effort), then DELETE
      try {
        log.info(`🔒 [deleteUser] Revoking sign-in sessions for userId=${user.id}…`);
        await revokeUserSessions(token, user.id);
        log.info("✅ [deleteUser] Sessions revoked");
      } catch (e) {
        log.warn("⚠️ [deleteUser] revokeSignInSessions failed:", e?.response?.data || e?.message || e);
      }

      try {
        log.info(`🗑️ [deleteUser] Deleting userId=${user.id}, upn=${user.userPrincipalName}`);
        await deleteUser(token, user.id);
        log.info("✅ [deleteUser] Delete status=204");
      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        log.error("❌ [deleteUser] DELETE /users/{id} failed:", details);
        markJob(job.id, { status: "failed", lastError: details });
        return;
      }

      // Verify not resolvable + Deleted Items present
      try {
        await getUser(token, user.id, "id");
        log.warn("⚠️ [deleteUser] Verification: user still resolvable (unexpected)");
      } catch (e) {
        if (e?.response?.status === 404) log.info("🧾 [deleteUser] Verification: user no longer resolvable (404 ✅)");
        else log.warn("[deleteUser] Verify read failed:", e?.response?.data || e?.message || e);
      }
      try {
        const inBin = await getDeletedUser(token, user.id);
        log.info(`[deleteUser] Deleted Items check: ${inBin ? "present ✅" : "not found"}`);
      } catch (e) {
        log.warn("[deleteUser] Deleted Items check failed:", e?.response?.data || e?.message || e);
      }

      markJob(job.id, { status: "done" });
      log.info(`📦 [deleteUser] Job ${job.id} done`);
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error("❌ [deleteUser] Failed:", details);
      markJob(job.id, { status: "failed", lastError: details });
      return;
    }
  }

  if (type === "disableuser") {
    const { employeeId, email, upn } = payload || {};
    log.info("🛑 [disableUser] Start with", { employeeId, email, upn });

    try {
      const token = await getAzureAccessToken();
      log.info("✅ [disableUser] Azure token OK");

      // Lookup user by employeeId → email → upn
      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;
      if (!user && email) user = await findByEmail(token, String(email).trim());
      if (!user && upn) user = await findUserByUPN(token, String(upn).trim());

      if (!user) {
        log.warn("⚠️ [disableUser] User not found");
        markJob(job.id, { status: "failed", lastError: "User not found for disable" });
        return;
      }

      // Disable user in Azure (accountEnabled = false)
      await updateUser(token, user.id, { accountEnabled: false });
      log.info(`✅ [disableUser] User disabled → id=${user.id}, upn=${user.userPrincipalName}`);

      // Success bookkeeping
      markJob(job.id, { status: "done" });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error("❌ [disableUser] Failed:", details);
      markJob(job.id, { status: "failed", lastError: details });
      return;
    }
  }


  // Unknown job type
  const msg = `Unknown job type: ${job.type}`;
  log.warn(`⚠️ ${msg}`);
  markJob(job.id, { status: "failed", lastError: msg });
}

function buildApp() {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(httpLogger);

  app.use("/api", routes);

  app.use((req, res, next) => next(new AppError(404, "Not Found")));
  app.use((err, req, res, next) => {
    const e = toAppError(err);
    log.error("Error", e.message, e.details || "");
    res
      .status(e.status || 500)
      .json({ message: e.message, details: e.details });
  });
  return app;
}

async function bootstrap() {
  process.on("unhandledRejection", (r) =>
    console.error("unhandledRejection", r)
  );
  process.on("uncaughtException", (e) => {
    console.error("uncaughtException", e);
  });

  await initSQLite();
  const app = buildApp();
  const port = parseInt(get("PORT", 3008), 10);
  app.listen(port, "0.0.0.0", () => log.info(`🚀 http://0.0.0.0:${port}`));

  const { tickRunner } = require("./infra/scheduler");
  tickRunner(executor);
}

bootstrap();
