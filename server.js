const express = require("express");
const app = express();
const axios = require("axios");
const PORT = 3008;
const qs = require("qs");
const { initBus, bus } = require('./src/core/bus');
require("dotenv").config();


app.use(express.json());
app.use(express.urlencoded({ extended: true }));
initBus();

// const AZURE_TOKEN = "eyJ0eXAiOiJKV1QiLCJub25jZSI6IkdnMUlxdVBUSk1kZS1ET2UwVzdoMGJ0ZVk5aU12X0hRV2xQalRhbnVac00iLCJhbGciOiJSUzI1NiIsIng1dCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSIsImtpZCI6IkpZaEFjVFBNWl9MWDZEQmxPV1E3SG4wTmVYRSJ9.eyJhdWQiOiJodHRwczovL2dyYXBoLm1pY3Jvc29mdC5jb20iLCJpc3MiOiJodHRwczovL3N0cy53aW5kb3dzLm5ldC85ZGJmNjU4NS01ZWIxLTRkMjYtODAyZS1hYWY3NTMyMzZjYjAvIiwiaWF0IjoxNzU2ODAzNTE1LCJuYmYiOjE3NTY4MDM1MTUsImV4cCI6MTc1NjgwNzQxNSwiYWlvIjoiazJSZ1lIaXovSGdEWi9DQmJpWHIxYy85WStjR0FnQT0iLCJhcHBfZGlzcGxheW5hbWUiOiJab2hvIFBlb3BsZSBJbnRlZ3JhdGlvbiIsImFwcGlkIjoiNzk1ODI5YWItNzllYy00MWYwLWJmOTQtYmM3ZmVmYjIwZDUzIiwiYXBwaWRhY3IiOiIxIiwiaWRwIjoiaHR0cHM6Ly9zdHMud2luZG93cy5uZXQvOWRiZjY1ODUtNWViMS00ZDI2LTgwMmUtYWFmNzUzMjM2Y2IwLyIsImlkdHlwIjoiYXBwIiwib2lkIjoiZGMwOGVkNTctNGEwMS00NWY1LTliNWItZDFhZDVmNWQ5ZDdmIiwicmgiOiIxLkFjWUFoV1dfbmJGZUprMkFMcXIzVXlOc3NBTUFBQUFBQUFBQXdBQUFBQUFBQUFEcEFBREdBQS4iLCJyb2xlcyI6WyJVc2VyLlJlYWRXcml0ZS5BbGwiLCJEaXJlY3RvcnkuUmVhZFdyaXRlLkFsbCJdLCJzdWIiOiJkYzA4ZWQ1Ny00YTAxLTQ1ZjUtOWI1Yi1kMWFkNWY1ZDlkN2YiLCJ0ZW5hbnRfcmVnaW9uX3Njb3BlIjoiQVMiLCJ0aWQiOiI5ZGJmNjU4NS01ZWIxLTRkMjYtODAyZS1hYWY3NTMyMzZjYjAiLCJ1dGkiOiJxN3dJMWo3Y2dVcUpteVFaX0pjOEFRIiwidmVyIjoiMS4wIiwid2lkcyI6WyIwOTk3YTFkMC0wZDFkLTRhY2ItYjQwOC1kNWNhNzMxMjFlOTAiXSwieG1zX2Z0ZCI6IkpzM0xMei12cjR3dFRrM1FiNmlYbE9yTUtZS0JUY1U1SXQzZVFnbUVqcGNCYTI5eVpXRmpaVzUwY21Gc0xXUnpiWE0iLCJ4bXNfaWRyZWwiOiI3IDE2IiwieG1zX3JkIjoiMC40MkxqWUJKaU9zWW9KTUxCTGlRZzNockxxTHgyamQtS1J6ZW1WbXRfRndlS2Nnb0pDS2szVkp3OHd1clg4R2JTbkxQVnVuNUFVUTRoQVdZR0NEZ0FwUUUiLCJ4bXNfdGNkdCI6MTc1MTYwNTk4NX0.RtU8x8g1-VNqr7rS9XQwU1NnkSFvPOGS5anIsBqGIL00-9w0UWYhl5_IaUCfQr2He-qlHfcvUxZrX_Oj5U4UqQDQtTqVpsxe8NBh56gJ4mzIXG3lQ-06rgJl6zpUpwLy9IlK3LGnW_mqqzH10lOE5BFggQXm7K_v4JmhTwEL8E8-lO3AW1y353gu64uygNjd32KyqmypGu1KjFMnR1dQa83sRkuX64m8wTh7IoKoMwf211mPhnU84ryRHAk3uVmbl4MoDGwj2BhixhQuzoVu_lF2eFWS0U617SVGJ7vRdNOMlszruAS1b77JC_FHE1xhVQT3gcF3dtxLBdVwONglTg";
// const ZOHO_TOKEN = "1000.5dc8f86d7b6dd00b3305d25cd6d83a25.f17e14c91ddf1cbfc05d4febc11e92a1"
const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;

let AZURE_ACCESS_TOKEN = "";
const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID;
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID;


async function getZohoAccessToken() {
  const tokenUrl = "https://accounts.zoho.com/oauth/v2/token";

  const formData = qs.stringify({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: "refresh_token",
  });

  const response = await axios.post(tokenUrl, formData, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return response.data.access_token;
}

async function getAzureAccessToken() {
  try {
    const response = await axios.post(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    AZURE_ACCESS_TOKEN = response.data.access_token;
    console.log("🔄 Refreshed Azure Access Token");
    return AZURE_ACCESS_TOKEN;
  } catch (err) {
    console.error("❌ Failed to refresh Azure token:", err.response?.data || err.message);
    throw err;
  }
}

function _normKey(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function pickWithKey(obj, aliases = []) {
  if (!obj) return { value: undefined, matchedKey: null };
  const lut = {};
  for (const [k, v] of Object.entries(obj)) lut[_normKey(k)] = { v, k };
  for (const a of aliases) {
    const hit = lut[_normKey(a)];
    if (hit && hit.v !== undefined && hit.v !== null && String(hit.v).trim() !== "") {
      return { value: hit.v, matchedKey: hit.k };
    }
  }
  return { value: undefined, matchedKey: null };
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


app.post("/zoho-candidate/edit", async (req, res) => {
  try {
    const data = req.body && Object.keys(req.body).length ? req.body : req.query;

    // Robust Employee Type capture
    const { value: employeeType, matchedKey: employeeTypeKey } = pickWithKey(data, [
      "employeeType", "employmentType", "employementType",
      "Employee_Type", "Employee Type", "EmployeeType",
      "empType", "typeOfEmployee"
    ]);

    const { id, firstname, lastname } = data;

    console.log("🧾 [prehire] Payload keys:", Object.keys(data));
    console.log("🧾 [prehire] Employee Type:", employeeType, "(matched key ->", employeeTypeKey, ")");
    console.log("Candidate received from Zoho Webhook:", data);

    if (!firstname || !lastname || !id) {
      return res.status(400).json({
        message: "Missing firstname, lastname, or candidate ID",
        received: data,
      });
    }

    // Build official email with prefix based on Employee Type
    const domain = process.env.OFFICIAL_EMAIL_DOMAIN || "roundglass.com";
    const local = normNickname(firstname, lastname);
    const pref = prefixForEmployeeType(employeeType);
    const officialEmail = `${pref}${local}@${domain}`;

    console.log("🧮 [prehire] Email decision:",
      { employeeType, prefix: pref || "(none)", local, domain, officialEmail });

    const formData = qs.stringify({
      recordId: id,
      inputData: JSON.stringify({ Other_Email: officialEmail }),
    });

    // Get fresh Zoho access token before making API call
    const accessToken = await getZohoAccessToken();
    console.log("🔑 [prehire] Zoho access token acquired.");

    const zohoResponse = await axios.post(
      "https://people.zoho.com/api/forms/json/Candidate/updateRecord",
      formData,
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("✅ [prehire] Zoho Candidate updated with Official Email:", officialEmail);

    res.status(200).json({
      message: "Official email generated and updated in Candidate record",
      officialEmail,
      employeeType,
      zohoResponse: zohoResponse.data,
    });
  } catch (error) {
    console.error(
      "❌ [prehire] Error processing Zoho webhook:",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Failed to process webhook",
      error: error.response?.data || error.message,
    });
  }
});

app.post("/zoho-webhook/create", async (req, res) => {
  try {
    const data = req.body && Object.keys(req.body).length ? req.body : req.query;

    const {
      email,
      firstname,
      lastname,
      employeeId,
      city,
      manager,
      joiningdate,
      company,
      zohoRole,
      mobilePhone,
      employementType,
      workPhone,
      employeeStatus,
      country,
      department,
      officelocation,
    } = data;

    console.log("Candidate received from Zoho Webhook:", data);

    if (!firstname || !lastname) {
      return res.status(400).json({
        message: "Missing firstname or lastname in webhook payload",
        received: data,
      });
    }

    const accessToken = await getAzureAccessToken();

    const safeNickname = `${firstname}.${lastname}`.toLowerCase()
      .replace(/[^a-z0-9.]/g, "");

    const domain = "yadavhitesh340gmail.onmicrosoft.com";
    let userPrincipalName = `${safeNickname}@${domain}`;

    let counter = 1;
    while (true) {
      const checkResponse = await axios.get(
        `https://graph.microsoft.com/v1.0/users?$filter=userPrincipalName eq '${userPrincipalName}'`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        }
      );

      if (checkResponse.data.value.length === 0) {
        break;
      }

      userPrincipalName = `${firstname.toLowerCase()}.${lastname.toLowerCase()}${counter}@${domain}`;
      counter++;
    }


    const azureUser = {
      accountEnabled: true,
      displayName: `${firstname} ${lastname}`,
      mailNickname: safeNickname,
      userPrincipalName,
      passwordProfile: {
        forceChangePasswordNextSignIn: true,
        password: "TempPass123!",
      },
      mail: email,
      givenName: firstname,
      surname: lastname,
      employeeId: employeeId || null,
      country: country || null,
      city: city || null,
      mobilePhone: mobilePhone || null,
      department: department || null,
      jobTitle: zohoRole || null,
      companyName: company || null,
      employeeType: employementType || null,
      officeLocation: officelocation || null,
    };

    const response = await axios.post(
      "https://graph.microsoft.com/v1.0/users",
      azureUser,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ User created in Azure AD:", response.data.id);

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = joiningdate.split("-");
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          const hireISO = dt.toISOString().replace(/\.\d{3}Z$/, "Z");

          await axios.patch(
            `https://graph.microsoft.com/v1.0/users/${response.data.id}`,
            { employeeHireDate: hireISO },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );

          console.log("✅ employeeHireDate set:", hireISO);
        }
      } catch (dateErr) {
        console.error("⚠️ Failed to set employeeHireDate:", dateErr.message);
      }
    }

    res.status(200).json({
      message: "User successfully created in Azure AD",
      azureUser: response.data,
    });

  } catch (error) {
    console.error(
      "❌ Error creating user in Azure AD:",
      error.response?.data || error.message
    );
    res.status(500).json({
      message: "Failed to create user in Azure AD",
      error: error.response?.data || error.message,
    });
  }
});

// --- DELETE (offboarding) webhook ---
// Triggers account disable at 14:20 IST on "Date of Exit", or immediately if missing.
router.post('/zoho-webhook/delete', (req, res) => {
  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;

    // Accept multiple possible identifier fields (Zoho often uses "Other Email")
    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const { email, employeeId } = data;

    // "Date of Exit" can arrive with different keys; accept common variants
    const exitDateRaw =
      data.dateOfExit ||
      data.Date_of_Exit ||
      data['Date of Exit'] ||
      data.dateofexit ||
      data.exitDate;

    // Config & timing
    const tz = process.env.TZ || 'Asia/Kolkata';
    const execHour = parseInt(process.env.OFFBOARD_EXEC_HOUR, 10);
    const execMin = parseInt(process.env.OFFBOARD_EXEC_MIN, 10);
    const H = Number.isFinite(execHour) ? execHour : 14;
    const M = Number.isFinite(execMin) ? execMin : 20;
    const quickMins = parseInt(process.env.OFFBOARD_OFFSET_MINUTES, 10);
    const QUICK = Number.isFinite(quickMins) ? quickMins : 1;

    // Parse "Date of Exit" (dd-MM-yyyy preferred; ISO fallback)
    const exitDtIST = parseJoinDateIST(exitDateRaw, tz); // reuses helper defined above

    let runAtDate;
    if (exitDtIST) {
      const targetIST = exitDtIST.set({ hour: H, minute: M, second: 0, millisecond: 0 });
      const candidate = new Date(targetIST.toUTC().toMillis());
      runAtDate = (candidate.getTime() <= Date.now())
        ? new Date(Date.now() + QUICK * 60 * 1000) // if time has passed, do soon
        : candidate;
    } else {
      // No "Date of Exit" → disable ASAP
      runAtDate = new Date(Date.now() + QUICK * 60 * 1000);
    }

    const runAt = runAtDate.getTime();

    const jobId = upsertJob({
      type: 'disableUser',
      runAt,
      payload: {
        // carry all identifiers we might use later
        upn: upn || null,
        email: email || null,
        employeeId: employeeId || null,
      }
    });

    return res.json({
      message: 'scheduled',
      jobId,
      runAt: new Date(runAt).toISOString(),
      computedFrom: exitDtIST ? 'exitDate-14:20-IST' : 'no-exitDate-immediate',
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`,
      quickFallbackMinutes: (exitDtIST && runAtDate.getTime() <= Date.now()) ? QUICK : (exitDtIST ? null : QUICK)
    });
  } catch (e) {
    console.error('❌ /zoho-webhook/delete failed:', e.stack || e.message || e);
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});


app.post("/zoho-webhook/edit", async (req, res) => {
  try {
    const data = req.body && Object.keys(req.body).length ? req.body : req.query;

    const {
      id,
      email,
      firstname,
      lastname,
      employeeId,
      city,
      manager,
      dob,
      age,
      gender,
      meritalStatus,
      bloodGroup,
      employementStatusComments,
      askMeAbout,
      weddingDay,
      empty,
      seatingLocation,
      officelocation,
      joiningdate,
      tags,
      presentAddress,
      permanentEmailAddress,
      tehsil,
      company,
      zohoRole,
      mobilePhone,
      employementType,
      workPhone,
      employeeStatus,
      homePhone,
      probation,
      country,
      rehire,
      department,
    } = data;

    console.log("Candidate received from Zoho Webhook:", data);

    if (!email) {
      return res.status(400).json({
        message: "Missing email in webhook payload (used to find Azure user)",
        received: data,
      });
    }

    // 🔹 Always get a fresh Azure token
    const accessToken = await getAzureAccessToken();

    // 🔹 Find Azure user by email
    const findResponse = await axios.get(
      `https://graph.microsoft.com/v1.0/users?$filter=mail eq '${email}'`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!findResponse.data.value || findResponse.data.value.length === 0) {
      return res.status(200).json({
        message: "User does not exist in Azure AD. Skipping update.",
      });
    }

    const existingUser = findResponse.data.value[0];

    // 🔹 Fields to update
    const updateUser = {
      displayName: `${firstname} ${lastname}`,
      givenName: firstname,
      surname: lastname,
      mail: email,
      employeeId: employeeId || null,
      country: country || null,
      city: city || null,
      mobilePhone: mobilePhone || null,
      department: department || null,
      jobTitle: zohoRole || null,
      companyName: company || null,
      employeeType: employementType || null,
      officeLocation: officelocation || null,
    };

    await axios.patch(
      `https://graph.microsoft.com/v1.0/users/${existingUser.id}`,
      updateUser,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = joiningdate.split("-");
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          const hireISO = dt.toISOString().replace(/\.\d{3}Z$/, "Z");

          await axios.patch(
            `https://graph.microsoft.com/v1.0/users/${existingUser.id}`,
            { employeeHireDate: hireISO },
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
              },
            }
          );
        }
      } catch (dateErr) {
        console.error("⚠️ Failed to set employeeHireDate:", dateErr.message);
      }
    }

    res.status(200).json({
      message: "User successfully updated in Azure AD",
      azureUser: existingUser.id,
    });

  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      message: "Failed to update user in Azure AD",
      error: error.response?.data || error.message,
    });
  }
});


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});
