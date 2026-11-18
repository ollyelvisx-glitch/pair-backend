const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const QRCode = require('qrcode');
const { rimraf } = require('rimraf');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const app = express();
app.use(cors());
app.use(express.json());

let currentQR = null;

app.get('/qr', async (req, res) => {
    const sessionDir = path.join(__dirname, 'sessions', `session_qr_${Date.now()}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, qr } = update;

            if (qr) {
                currentQR = qr;
            }

            if (connection === 'open') {
                console.log(`[+] Device linked successfully via QR!`);
            }
        });

        // Give socket a couple seconds to generate the QR
        setTimeout(async () => {
            if (currentQR) {
                try {
                    // Generate a data URL image of the QR code
                    const qrImage = await QRCode.toDataURL(currentQR);
                    res.json({ success: true, qrImage: qrImage });
                } catch (err) {
                    res.status(500).json({ error: "Failed to render QR image" });
                }
            } else {
                res.status(408).json({ error: "QR generation timed out. Try again." });
            }
        }, 3500);

    } catch (err) {
        console.error("Server Error:", err);
        res.status(500).json({ error: "Internal server error." });
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: "online", time: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 QR Pairing server active on port ${PORT}`));
