const axios = require('axios');
const qs = require('qs');
const { get } = require('../config/env');

async function getAzureAccessToken() {
  const tenant = get('AZURE_TENANT_ID');
  const clientId = get('AZURE_CLIENT_ID');
  const clientSecret = get('AZURE_CLIENT_SECRET');

  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Azure credentials missing (tenant/clientId/clientSecret)');
  }

  const body = qs.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const res = await axios.post(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    body,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );

  return res.data.access_token;
}

module.exports = { getAzureAccessToken };
