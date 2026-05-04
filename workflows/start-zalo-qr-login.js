const fs = require('node:fs');
const path = require('node:path');

const axios = require('axios');
const { Zalo } = require(path.join(
  __dirname,
  '..',
  '.n8n',
  '.n8n',
  'nodes',
  'node_modules',
  'zca-js',
));

const N8N_API_URL = 'http://127.0.0.1:5678';
const N8N_API_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI1ZjYxODM5ZS0wYmIyLTQ4N2MtOTM5OC0xNGE2OWNkZjIxODQiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwiaWF0IjoxNzc2NjcxMzM3fQ.DRHSvOiP3m5LHsmk58wfqFqbU6whauU5M7yVUkk6e9Q';
const QR_PATH = path.join(__dirname, 'zalo-qr.png');
const LOG_PATH = path.join(__dirname, 'zalo-qr-login.log');

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(LOG_PATH, line + '\n');
  console.log(line);
}

async function saveCredential(loginInfo) {
  await axios.post(
    `${N8N_API_URL}/api/v1/credentials`,
    {
      name: `Zalo API Credentials ${new Date().toISOString()}`,
      type: 'zaloApi',
      data: {
        cookie: JSON.stringify(loginInfo.cookie),
        imei: loginInfo.imei,
        userAgent: loginInfo.userAgent,
        proxy: '',
      },
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'X-N8N-API-KEY': N8N_API_KEY,
      },
      timeout: 20000,
    },
  );
}

async function main() {
  if (fs.existsSync(QR_PATH)) {
    fs.unlinkSync(QR_PATH);
  }

  log('Starting Zalo QR login flow');
  const zalo = new Zalo({ selfListen: true, logging: true });
  let loginInfo;

  await zalo.loginQR({ qrPath: QR_PATH }, async (qrEvent) => {
    switch (qrEvent.type) {
      case 0:
        if (qrEvent.data?.image) {
          fs.writeFileSync(QR_PATH, Buffer.from(qrEvent.data.image, 'base64'));
        }
        log(`QR generated at ${QR_PATH}`);
        break;
      case 1:
        log('QR expired');
        qrEvent.actions.abort();
        process.exit(1);
        break;
      case 2:
        log(
          `QR scanned by ${qrEvent.data?.display_name ?? 'unknown account'}`,
        );
        break;
      case 3:
        log('QR declined on phone');
        qrEvent.actions.abort();
        process.exit(1);
        break;
      case 4:
        loginInfo = {
          cookie: qrEvent.data?.cookie || [],
          imei: qrEvent.data?.imei || '',
          userAgent: qrEvent.data?.userAgent || '',
        };
        log('Login credentials received from Zalo, saving into n8n');
        try {
          await saveCredential(loginInfo);
          log('zaloApi credential saved successfully');
          process.exit(0);
        } catch (error) {
          log(`Failed to save credential: ${error.message}`);
          process.exit(1);
        }
        break;
      default:
        log(`Unhandled QR event type: ${qrEvent.type}`);
        break;
    }
  });
}

main().catch((error) => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
