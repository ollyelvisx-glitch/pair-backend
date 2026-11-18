const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const { rimraf } = require('rimraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/pair', async (req, res) => {
    let phone = req.query.phone;

    if (!phone) {
        return res.status(400).json({ error: "Phone number is required" });
    }

    // Remove +, spaces, and dashes
    phone = phone.replace(/[^0-9]/g, '');

    if (phone.length < 10) {
        return res.status(400).json({ error: "Invalid number. Include your country code (e.g. 256700000000)." });
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
            browser: ["Ubuntu", "Chrome", "20.0.04"]
        });

        sock.ev.on('creds.update', saveCreds);

        let codeSent = false;

        sock.ev.on('connection.update', async (update) => {
            const { qr, connection } = update;

            if (qr && !sock.authState.creds.registered && !codeSent) {
                codeSent = true;
                try {
                    await new Promise(r => setTimeout(r, 2000));
                    const code = await sock.requestPairingCode(phone);
                    
                    res.json({ success: true, code: code });

                    // Clean up temporary session after 40 seconds
                    setTimeout(() => {
                        try {
                            sock.ws.close();
                            rimraf.sync(sessionDir);
                        } catch (e) {}
                    }, 40000);

                } catch (err) {
                    console.error("Pairing error:", err);
                    if (!res.headersSent) {
                        res.status(500).json({ error: "Failed to generate code. Check number format." });
                    }
                    rimraf.sync(sessionDir);
                }
            }

            if (connection === 'open') {
                console.log(`[+] ${phone} connected!`);
            }
        });

    } catch (err) {
        console.error("Server error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: "Internal server error." });
        }
        rimraf.sync(sessionDir);
    }
});

// Keep-alive route for UptimeRobot
app.get('/ping', (req, res) => {
    res.json({ status: "online", timestamp: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));