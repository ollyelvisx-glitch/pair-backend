const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const { rimraf } = require('rimraf');
const fs = require('fs');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers, delay } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
    }

    phone = phone.replace(/[^0-9]/g, '');

    if (phone.length < 10) {
        return res.status(400).json({ error: "Invalid number. Include your country code." });
    }

    const sessionDir = path.join(__dirname, 'sessions', `session_${phone}_${Date.now()}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.macOS("Chrome")
        });

        sock.ev.on('creds.update', saveCreds);

        let codeSent = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;

            if (!sock.authState.creds.registered && !codeSent) {
                codeSent = true;
                try {
                    await delay(3000);
                    const code = await sock.requestPairingCode(phone);
                    
                    if (!res.headersSent) {
                        res.json({ success: true, code: code });
                    }
                } catch (err) {
                    console.error("Error requesting code:", err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: "Failed to generate pairing code." });
                    }
                }
            }

            if (connection === 'open') {
                console.log(`[+] Phone ${phone} connected successfully!`);
                
                // Once connected, read the creds file and generate a Session ID string
                setTimeout(async () => {
                    try {
                        const credsPath = path.join(sessionDir, 'creds.json');
                        if (fs.existsSync(credsPath)) {
                            const credsData = fs.readFileSync(credsPath, 'utf8');
                            // Base64 encode the creds as a Session ID string
                            const sessionId = Buffer.from(credsData).toString('base64');
                            console.log("Generated Session ID:", sessionId);
                        }
                    } catch (e) {
                        console.error("Error reading creds:", e);
                    }
                }, 2000);
            }
        });

    } catch (err) {
        console.error("Server Error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error." });
        }
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: "online", time: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Pairing server active on port ${PORT}`));
