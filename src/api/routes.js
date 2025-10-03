const express = require("express");
const router = express.Router();
const { log } = require("../core/logger");
const { upsertJob, markJob } = require("../infra/sqlite");
const { getInt, get } = require("../config/env");
const { getAzureAccessToken } = require("../services/graphAuth");
const { parseJoinDate, computeRunAtFromJoin } = require('../utils/dates');
const { DateTime } = require('luxon');
const { getZohoAccessToken } = require("../services/zohoPeople");
const axios = require("axios");
const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  revokeUserSessions,
  deleteUser,
  getDeletedUser,
  updateUser,
  findUserByDisplayName,
} = require("../services/graphUser");
const qs = require('qs');
const { findActiveJobByCandidate, findLatestJobByCandidate, getKV } = require("../infra/sqlite");
const { updateCandidateOfficialEmail } = require("../services/zohoPeople");




router.get("/health", (req, res) =>
  res.json({ status: "ok", time: new Date().toISOString() })
);

function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

// dd-MM-yyyy -> DateTime in IST (no time set yet)
function parseJoinDateIST(s, tz) {
  if (!s) return null;
  const dt = DateTime.fromFormat(String(s).trim(), "dd-LL-yyyy", { zone: tz });
  return dt.isValid ? dt : null;
}
function computeRun({ joinDtIST, offsetDays, execHour, execMin }) {
  const targetIST = joinDtIST
    .minus({ days: offsetDays })
    .set({ hour: execHour, minute: execMin, second: 0, millisecond: 0 });
  return new Date(targetIST.toUTC().toMillis());
}


function prefixForEmployeeType(t) {
  if (!t) return "";
  const s = String(t).toLowerCase();
  if (s.includes("contractor")) return "c-";
  if (s.includes("intern")) return "i-";
  return "";
}

function normNickname(first, last) {
  return `${String(first || "").toLowerCase()}.${String(last || "").toLowerCase()}`
    .replace(/[^a-z0-9.]/g, "");
}
function prefixForEmployeeType(t) {
  if (!t) return "";
  const s = String(t).toLowerCase();
  if (s.includes("contractor")) return "c-";
  if (s.includes("intern")) return "i-";
  return "";
}

const tz = process.env.TZ || "Asia/Kolkata";

function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

// Take from .env, fallback to 14:20 if not set
const H = clamp(getInt("OFFBOARD_EXEC_HOUR", 14), 0, 23);
const M = clamp(getInt("OFFBOARD_EXEC_MIN", 20), 0, 59);

log.info(` Offboard exec time (IST) → ${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`);

router.post("/zoho-candidate/edit", async (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const { id, firstname, lastname, email, employeeId, joiningdate } = data;
    const employeeType = data.employeeType; // exact key from Zoho

    console.log("🧾 [prehire] Payload keys:", Object.keys(data));
    console.log("🧾 [prehire] Employee Type (employeeType):", employeeType);
    console.log("🧾 [prehire] Candidate:", { id, firstname, lastname, joiningdate });

    if (!id || !firstname || !lastname) {
      return res.status(400).json({
        message: "Missing firstname, lastname, or candidate ID",
        received: data
      });
    }

    // ---- Scheduling: 5 days before join (configurable), else quick fallback ----
    const tz = process.env.TZ || "Asia/Kolkata";

    // === COOL-DOWN: suppress echo webhooks for a short window after a success ===
    // Requires: const { getKV } = require("../infra/sqlite");
    // Also set via executor in index.js (see below)
    const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES, 3); // default 3 minutes
    const untilStr = getKV(`CANDIDATE_COOLDOWN_UNTIL:${id}`);
    const until = untilStr ? Number(untilStr) : 0;
    if (until && Date.now() < until) {
      const msLeft = until - Date.now();
      console.log("🛑 [prehire] Cool-down active; suppressing schedule", {
        candidateId: id,
        msLeft
      });
      return res.json({
        message: "cooldown_active",
        candidateId: id,
        retryAfterMs: msLeft
      });
    }

    const execHour = toInt(process.env.PREHIRE_EXEC_HOUR, 14);
    const execMin = toInt(process.env.PREHIRE_EXEC_MIN, 45);
    const quickMins = toInt(process.env.POSTJOIN_OFFSET_MINUTES, 2);
    const prehireDays = toInt(process.env.PREHIRE_OFFSET_DAYS, 5);

    const joinDtIST = parseJoinDateIST(joiningdate, tz);
    let runAtDate, reason;

    if (joinDtIST) {
      const nowIST = DateTime.now().setZone(tz);
      const prehireIST = joinDtIST
        .minus({ days: prehireDays })
        .set({ hour: execHour, minute: execMin, second: 0, millisecond: 0 });

      if (prehireIST > nowIST) {
        runAtDate = new Date(prehireIST.toUTC().toMillis());
        reason = `prehire-${prehireDays}d`;
      } else {
        runAtDate = new Date(nowIST.plus({ minutes: quickMins }).toUTC().toMillis());
        reason = 'prehire-in-past->quick';
      }
    } else {
      const nowIST = DateTime.now().setZone(tz);
      runAtDate = new Date(nowIST.plus({ minutes: quickMins }).toUTC().toMillis());
      reason = 'no-join->quick';
    }

    const runAt = runAtDate.getTime();
    const execAtISTLabel = DateTime.fromMillis(runAt).setZone(tz).toFormat('HH:mm');

    console.log('🗓️ [prehire] Schedule decision:', {
      computedFrom: reason,
      prehireDays,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      execAtIST: execAtISTLabel,
      runAtUTC: new Date(runAt).toISOString(),
    });

    // Still keep your "active job" de-dupe for quick duplicate webhook bursts
    const existing = findActiveJobByCandidate('createFromCandidate', id);
    if (existing) {
      const toleranceMs = 60 * 1000;
      if (Math.abs(existing.runAt - runAt) > toleranceMs) {
        markJob(existing.id, {
          status: 'cancelled',
          lastError: 'superseded by new schedule',
          result: { supersededBy: { runAt } },
        });
        console.log('🔁 [prehire] Superseding old job', {
          oldJobId: existing.id,
          oldRunAtUTC: new Date(existing.runAt).toISOString(),
          newRunAtUTC: new Date(runAt).toISOString()
        });
        // fall through to enqueue new job
      } else {
        const runAtIstExisting = DateTime.fromMillis(existing.runAt).setZone(tz)
          .toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
        console.log('⏩ [prehire] Duplicate call suppressed: job already active', {
          jobId: existing.id,
          status: existing.status,
          runAtUTC: new Date(existing.runAt).toISOString(),
          runAtIST: runAtIstExisting,
        });
        return res.json({
          message: 'already_scheduled',
          jobId: existing.id,
          status: existing.status,
          runAtUTC: new Date(existing.runAt).toISOString(),
          runAtIST: runAtIstExisting,
        });
      }
    }

    const jobId = upsertJob({
      type: "createFromCandidate",
      runAt,
      payload: {
        candidateId: id,
        firstname,
        lastname,
        email,
        employeeId,                     // optional seed if provided
        joiningdate: joiningdate || null,
        offsetDays: prehireDays,        // keep executor happy if it destructures offsetDays
        domain: get("AZURE_DEFAULT_DOMAIN"),
        employeeType,
        employementType: employeeType,  // legacy key kept in sync
      },
    });

    console.log("📬 [prehire] Enqueued createFromCandidate", {
      jobId,
      runAtUTC: new Date(runAt).toISOString(),
      execAtIST: execAtISTLabel,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      prehireDays,
    });

    if (String(process.env.ZP_PROVISIONAL_UPDATE || 'false').toLowerCase() === 'true') {
      try {
        const domain = process.env.OFFICIAL_EMAIL_DOMAIN || get("AZURE_DEFAULT_DOMAIN") || "roundglass.com";
        const local = normNickname(firstname, lastname);
        const pref = prefixForEmployeeType(employeeType);
        const provisional = `${pref}${local}@${domain}`;

        await updateCandidateOfficialEmail({ recordId: id, officialEmail: provisional });
        console.log("✅ [prehire] Provisional Official Email set in Zoho:", provisional);
      } catch (zerr) {
        console.warn("⚠️ [prehire] Provisional Zoho update skipped/failed:", zerr?.response?.data || zerr?.message || zerr);
      }
    } else {
      console.log("⏭️  [prehire] Skipping provisional Zoho update (ZP_PROVISIONAL_UPDATE!=true)");
    }

    return res.json({
      message: "scheduled",
      jobId,
      runAt: new Date(runAt).toISOString(),
      computedFrom: reason,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      execAtIST: execAtISTLabel,
      prehireDays,
      quickFallbackMinutes: reason.includes('quick') ? quickMins : null,
    });
  } catch (error) {
    console.error("❌ [prehire] Error processing Zoho webhook:", error?.response?.data || error.message);
    return res.status(500).json({
      message: "Failed to process webhook",
      error: error?.response?.data || error.message,
    });
  }
});


router.post('/zoho-webhook/edit', async (req, res) => {
  const startedAt = new Date().toISOString();
  console.log('➡️  HIT /api/zoho-webhook/edit', {
    ts: startedAt,
    ip: req.ip,
    ua: req.get('user-agent')
  });

  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;
    console.log('🧾 Raw payload:', JSON.stringify(data));

    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const { email, employeeId, manager } = data; // manager field from Zoho
    console.log('🔍 Identifiers received:', { upn, email, employeeId, manager });

    const {
      firstname,
      lastname,
      city,
      country,
      mobilePhone,
      department,
      zohoRole,
      company,
      employementType,
      officelocation,
      joiningdate,
    } = data;

    console.log(
      '🧩 Optional update fields present:',
      Object.keys({
        firstname, lastname, city, country, mobilePhone, department,
        zohoRole, company, employementType, officelocation, joiningdate
      }).filter(k => data[k] !== undefined)
    );

    console.log('🔑 Fetching Azure token…');
    const token = await getAzureAccessToken();
    console.log('✅ Azure token OK');

    let user = null;
    let lookedUpBy = null;

    if (upn) {
      console.log('🔎 Trying lookup by UPN:', upn);
      user = await findUserByUPN(token, String(upn).trim());
      if (user) lookedUpBy = `UPN:${upn}`;
    }
    if (!user && email) {
      console.log('🔎 Trying lookup by email:', email);
      user = await findByEmail(token, String(email).trim());
      if (user) lookedUpBy = `email:${email}`;
    }
    if (!user && employeeId) {
      console.log('🔎 Trying lookup by employeeId:', employeeId);
      user = await findByEmployeeId(token, String(employeeId).trim());
      if (user) lookedUpBy = `employeeId:${employeeId}`;
    }

    if (!user) {
      console.warn('⚠️  No Azure user found with provided identifiers.');
      return res.status(404).json({
        message: 'Azure user not found. Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.',
        tried: { upn: upn || null, email: email || null, employeeId: employeeId || null }
      });
    }

    // Build patch
    const patch = {
      displayName:
        (firstname || lastname)
          ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim()
          : undefined,
      givenName: firstname || undefined,
      surname: lastname || undefined,
      mail: email || undefined,
      employeeId: employeeId || undefined,
      country: country || undefined,
      city: city || undefined,
      mobilePhone: mobilePhone || undefined,
      department: department || undefined,
      jobTitle: zohoRole || undefined,
      companyName: company || undefined,
      employeeType: employementType || undefined,
      officeLocation: officelocation || undefined,
    };

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = String(joiningdate).split('-');
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          patch.employeeHireDate = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
      } catch (e) {
        console.warn('⚠️  Failed to parse joiningdate -> employeeHireDate:', e.message);
      }
    }

    let managerUser = null;
    if (manager) {
      const managerCode = manager.split(' ').pop();
      managerUser = await findByEmployeeId(token, managerCode);
    }

    if (managerUser && managerUser.id) {
      console.log('📡 Updating manager for user:', user.id);
      await axios.put(
        `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
        {
          "@odata.id": `https://graph.microsoft.com/v1.0/directoryObjects/${managerUser.id}`
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        }
      );
      console.log('✅ Manager updated successfully');
    }

    else {
      console.error('❌ Manager not found in Azure using employeeId, cannot patch manager field');
    }

    Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
    console.log('🛠️  Patch keys to apply:', Object.keys(patch));

    if (Object.keys(patch).length === 0) {
      console.log('ℹ️  Nothing to update; no valid fields in payload.');
      return res.json({
        message: 'Nothing to update; no valid fields provided',
        userId: user.id,
        upn: user.userPrincipalName,
        lookedUpBy,
      });
    }

    console.log('📡 Sending PATCH to Microsoft Graph for user:', user.id);
    await updateUser(token, user.id, patch);
    console.log('✅ Azure user updated:', { userId: user.id, lookedUpBy });

    return res.json({
      message: 'Azure user updated',
      userId: user.id,
      upn: user.userPrincipalName,
      lookedUpBy,
      updatedFields: Object.keys(patch),
      handledAt: new Date().toISOString()
    });
  } catch (err) {
    const details = err?.response?.data || err?.message || String(err);
    console.error('❌ /api/zoho-webhook/edit failed:', details);
    return res.status(500).json({ message: 'Failed to update Azure user', details });
  }
});


function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") {
      return obj[k];
    }
  }
  return undefined;
}

function parseJoinDateIST(s, tz) {
  if (!s) return null;
  const dt = DateTime.fromFormat(String(s).trim(), "dd-LL-yyyy", { zone: tz });
  return dt.isValid ? dt : null;
}

router.post("/zoho-webhook/delete", async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info("➡️  HIT /api/zoho-webhook/delete", {
    ts: startedAt,
    ip: req.ip,
    ua: req.get("user-agent"),
  });

  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;
    log.info("🧾 Raw payload:", JSON.stringify(data));

    const employeeId = pick(data, ["employeeId", "EmployeeID", "EmpID", "Emp Id", "empId"]);
    const email = pick(data, ["email", "mail", "Email"]);
    const upn = pick(data, ["userPrincipalName", "upn", "Other_Email", "Other Email", "otherEmail"]);

    // Zoho commonly sends "dateOFExit"
    const exitDateRaw = pick(data, ["dateOFExit", "dateOfExit", "Date_of_Exit", "Date of Exit", "dateofexit", "exitDate"]);
    log.info("🔎 Identifiers for delete:", { employeeId, email, upn, exitDateRaw });

    if (!employeeId) {
      log.warn("⚠️ employeeId is required for strict delete");
      return res.status(400).json({ message: "employeeId is required" });
    }

    const tz = process.env.TZ || "Asia/Kolkata";
    const H = getInt("OFFBOARD_EXEC_HOUR", 14);
    const M = getInt("OFFBOARD_EXEC_MIN", 20);

    // If exit date present, schedule for H:M IST on that date
    const exitDtIST = parseJoinDateIST(exitDateRaw, tz);
    const futureCandidate = exitDtIST
      ? new Date(exitDtIST.set({ hour: H, minute: M, second: 0, millisecond: 0 }).toUTC().toMillis())
      : null;

    // === Immediate path if no date or time already passed ===
    if (!futureCandidate || futureCandidate.getTime() <= Date.now()) {
      log.info("🟢 Immediate mode: delete now (no job)");
      log.info("🔑 [delete-now] Fetching Azure token…");
      const token = await getAzureAccessToken();
      log.info("✅ [delete-now] Azure token OK");

      // Locate strictly by employeeId; email/UPN only if they match the same employeeId
      log.info(`🔎 [delete-now] Lookup by employeeId="${employeeId}"…`);
      let user = await findByEmployeeId(token, String(employeeId).trim());
      let foundBy = user ? "employeeId" : null;

      if (!user && email) {
        log.info(`🔎 [delete-now] Fallback by email="${email}" (verify employeeId)…`);
        const byEmail = await findByEmail(token, String(email).trim());
        if (byEmail && String(byEmail.employeeId ?? "").trim() === String(employeeId).trim()) {
          user = byEmail; foundBy = "email+eid";
          log.info("✅ [delete-now] Email matched and employeeId verified");
        }
      }

      if (!user && upn) {
        log.info(`🔎 [delete-now] Fallback by UPN="${upn}" (verify employeeId)…`);
        const byUpn = await findUserByUPN(token, String(upn).trim());
        if (byUpn && String(byUpn.employeeId ?? "").trim() === String(employeeId).trim()) {
          user = byUpn; foundBy = "upn+eid";
          log.info("✅ [delete-now] UPN matched and employeeId verified");
        }
      }

      if (!user) {
        log.warn("⚠️ [delete-now] Azure user not found with matching employeeId");
        return res.status(404).json({ message: "Azure user not found with matching employeeId", employeeId });
      }

      const azureEmpId = String(user.employeeId ?? "").trim();
      if (foundBy !== "employeeId" && azureEmpId !== String(employeeId).trim()) {
        log.warn(`⚠️ [delete-now] employeeId mismatch (Azure="${azureEmpId}" vs Zoho="${employeeId}")`);
        return res.status(409).json({ message: "employeeId mismatch", azureEmpId, zohoEmployeeId: String(employeeId).trim() });
      }

      // Revoke sessions → Delete → Verify
      try {
        log.info(`[delete-now] Revoking sign-in sessions for userId=${user.id}…`);
        await revokeUserSessions(token, user.id);     // POST /revokeSignInSessions (no body)
        log.info("[delete-now] Sessions revoked");
      } catch (e) {
        log.warn("[delete-now] revokeSignInSessions failed:", e?.response?.data || e?.message || e);
      }

      try {
        log.info(`[delete-now] Deleting userId=${user.id}, upn=${user.userPrincipalName}`);
        log.info(`[disable-now] Disabling userId=${user.id}, upn=${user.userPrincipalName}`);
        await updateUser(token, user.id, { accountEnabled: false });
        log.info("[disable-now] Account disabled ✅");

        // 🔹 Remove all group memberships
        try {
          log.info(`[disable-now] Fetching group memberships for userId=${user.id}`);
          const groupsRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${user.id}/memberOf?$select=id`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const groups = groupsRes.data.value || [];

          if (groups.length === 0) {
            log.info("[disable-now] No group memberships found ✅");
          } else {
            for (const g of groups) {
              try {
                log.info(`[disable-now] Removing from group ${g.id}`);
                await axios.delete(
                  `https://graph.microsoft.com/v1.0/groups/${g.id}/members/${user.id}/$ref`,
                  { headers: { Authorization: `Bearer ${token}` } }
                );
              } catch (err) {
                log.warn(`[disable-now] Failed to remove from group ${g.id}:`, err?.response?.data || err?.message || err);
              }
            }
            log.info("[disable-now] All group memberships removed ✅");
          }
        } catch (e) {
          log.warn("[disable-now] Failed to fetch/remove groups:", e?.response?.data || e?.message || e);
        }

        try {
          log.info(`[disable-now] Removing manager for userId=${user.id}`);
          await axios.delete(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          log.info("[disable-now] Manager removed ✅");
        } catch (e) {
          log.warn("[disable-now] Failed to remove manager:", e?.response?.data || e?.message || e);
        }


      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        log.error("[delete-now] DELETE /users/{id} failed:", details);
        return res.status(e?.response?.status || 502).json({ message: "Delete failed", details });
      }

      // Verify not resolvable + Deleted Items present
      try {
        await getUser(token, user.id, "id");
        log.warn("[delete-now] Verification: user still resolvable (unexpected)");
      } catch (e) {
        if (e?.response?.status === 404) log.info("[delete-now] Verification: user no longer resolvable (404 ✅)");
        else log.warn("[delete-now] Verify read failed:", e?.response?.data || e?.message || e);
      }

      try {
        const inBin = await getDeletedUser(token, user.id);
        log.info(`[delete-now] Deleted Items check: ${inBin ? "present ✅" : "not found"}`);
      } catch (e) {
        log.warn("[delete-now] Deleted Items check failed:", e?.response?.data || e?.message || e);
      }

      return res.json({
        message: "deleted",
        userId: user.id,
        upn: user.userPrincipalName,
        employeeId: azureEmpId || String(employeeId).trim(),
        mode: "immediate",
      });
    }

    const runAt = futureCandidate.getTime();

    upsertJob({
      type: "disableUser",
      runAt,
      payload: {
        employeeId: String(employeeId).trim(),
        email: email || null,
        upn: upn || null,
      },
    });
    log.info(`📬 Enqueued deleteUser for ${futureCandidate.toISOString()} (id hidden)`);

    return res.json({
      message: "scheduled",
      runAt: futureCandidate.toISOString(),
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`,
      mode: "scheduled",
    });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    console.error("❌ /zoho-webhook/delete failed:", details);
    return res.status(500).json({ message: "Internal Server Error", details });
  }
});

router.post("/employee-type/edit", async (req, res) => {
  log.info("➡️  HIT /api/employee-type/edit", {
    ts: new Date().toISOString(),
    ip: req.ip,
    ua: req.get("user-agent"),
  });

  try {
    const { employeeId, type } = req.body;

    log.info("📩 Employment type edit webhook received", { employeeId, type });

    if (!employeeId || !type) {
      return res.status(400).json({ message: "employeeId and type are required" });
    }

    // 🔑 Get Azure token
    log.info("🔑 Fetching Azure token…");
    const token = await getAzureAccessToken();
    log.info("✅ Azure token OK");

    // 🔎 Find user by employeeId
    log.info(`🔎 Looking up user in Azure with employeeId=${employeeId}`);
    const user = await findByEmployeeId(token, employeeId);

    if (!user) {
      log.warn("⚠️ No Azure user found for given employeeId");
      return res.status(404).json({ message: "User not found in Azure" });
    }

    log.info("✅ Found user", {
      id: user.id,
      upn: user.userPrincipalName,
      mail: user.mail,
    });

    const upn = user.userPrincipalName;
    let aliasEmail = null;

    // ---------------------------
    // CASE 1: Regular Full-Time
    // ---------------------------
    if (type === "Regular Full-Time") {
      aliasEmail = upn.replace(/^(i-|c-)/, "");
    }

    // ---------------------------
    // CASE 2: Intern Full-Time
    // ---------------------------
    else if (type === "Intern Full-Time") {
      if (upn.startsWith("i-")) {
        log.info("ℹ️ Intern already has correct UPN, no action needed");
        return res.json({ message: "No change needed" });
      } else {
        const withoutPrefix = upn.replace(/^(i-|c-)/, "");
        aliasEmail = `i-${withoutPrefix}`;
      }
    }

    // ---------------------------
    // CASE 3: Contractor Full-Time
    // ---------------------------
    else if (type === "Contractor Full-Time") {
      if (upn.startsWith("c-")) {
        log.info("ℹ️ Contractor already has correct UPN, no action needed");
        return res.json({ message: "No change needed" });
      } else {
        const withoutPrefix = upn.replace(/^(i-|c-)/, "");
        aliasEmail = `c-${withoutPrefix}`;
      }
    }

    // If no alias is required, skip
    if (!aliasEmail) {
      log.info("ℹ️ No alias email to add, skipping PATCH");
      return res.json({ message: "No change needed" });
    }

    log.info("📧 New alias email to add:", aliasEmail);

    // get current aliases from Azure user
    const currentAliases = user.otherMails || [];

    // avoid duplicates
    if (currentAliases.includes(aliasEmail)) {
      log.info(`ℹ️ Alias ${aliasEmail} already exists in otherMails, no action needed`);
      return res.json({ message: "Alias already present", employeeId, aliasEmail });
    }

    const updatedAliases = [...currentAliases, aliasEmail];

    const patch = {
      otherMails: updatedAliases,
    };

    log.info("📡 Sending PATCH to Microsoft Graph", patch);
    await updateUser(token, user.id, patch);

    return res.json({
      message: "Alias email added",
      employeeId,
      aliasEmail,
    });
  } catch (e) {
    const details = e?.response?.data || e?.message || e;
    log.error("❌ /employee-type/edit failed:", details);
    return res.status(500).json({ message: "Internal Server Error", details });
  }
});



module.exports = router;
