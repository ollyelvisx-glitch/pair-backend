const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const { rimraf } = require('rimraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
    }

    // Sanitize phone number (digits only)
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
            logger: pino({ level: 'fatal' }),
            printQRInTerminal: false,
            auth: state,
            browser: Browsers.macOS("Chrome") // Using standard Baileys macOS browser profile
        });

        sock.ev.on('creds.update', saveCreds);

        let codeSent = false;

        sock.ev.on('connection.update', async (update) => {
            const { connection } = update;

            if (!sock.authState.creds.registered && !codeSent) {
                codeSent = true;
                try {
                    // Wait a moment for socket to stabilize before requesting code
                    await new Promise(r => setTimeout(r, 3000));
                    const code = await sock.requestPairingCode(phone);
                    
                    if (!res.headersSent) {
                        res.json({ success: true, code: code });
                    }

                    // Clean up session folder after 45 seconds
                    setTimeout(async () => {
                        try {
                            sock.ws.close();
                            rimraf.sync(sessionDir);
                        } catch (e) {}
                    }, 45000);

                } catch (err) {
                    console.error("Error requesting code:", err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: "Failed to generate pairing code." });
                    }
                    rimraf.sync(sessionDir);
                }
            }

            if (connection === 'open') {
                console.log(`[+] Phone ${phone} connected successfully!`);
            }
        });

    } catch (err) {
        console.error("Server Error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error." });
        }
        rimraf.sync(sessionDir);
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: "online", time: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Pairing server active on port ${PORT}`));
