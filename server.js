const express = require('express');
const cors = require('cors');
const pino = require('pino');
const path = require('path');
const QRCode = require('qrcode');
const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');

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
                console.log(`[+] Bot connected and listening!`);
            }
        });

        // Robust message event listener & command handler
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            if (!m.message) return;

            const senderJid = m.key.remoteJid;

            // 1. Extract text safely across different message types
            const text = m.message.conversation || 
                         m.message.extendedTextMessage?.text || 
                         m.message.imageMessage?.caption || 
                         m.message.videoMessage?.caption || '';

            console.log(`[Incoming Message] From ${senderJid}: "${text}"`);

            // 2. Anti-View Once Catcher
            const messageType = Object.keys(m.message)[0];
            if (messageType === 'viewOnceMessage' || messageType === 'viewOnceMessageV2') {
                try {
                    const buffer = await downloadMediaMessage(
                        m,
                        'buffer',
                        {},
                        { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
                    );
                    const myNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';
                    await sock.sendMessage(myNumber, {
                        image: buffer,
                        caption: `🔓 *Saved View-Once Media* from ${senderJid}`
                    });
                } catch (err) {
                    console.error("Failed to save view-once:", err);
                }
                return;
            }

            // 3. Command Handler (Triggers on prefix .)
            if (!text.startsWith('.')) return;

            const command = text.slice(1).trim().split(' ')[0].toLowerCase();
            console.log(`[Command Triggered] -> ${command}`);

            if (command === 'ping') {
                await sock.sendMessage(senderJid, { text: 'Pong! Bot is online and listening 🟢' }, { quoted: m });
            } 
            else if (command === 'settings') {
                const settingsMsg = 
                    `⚙️ *BOT SETTINGS PANEL* ⚙️\n\n` +
                    `• *Prefix:* .\n` +
                    `• *Anti-View Once:* Active 🟢\n` +
                    `• *Status:* Connected & Responsive`;
                await sock.sendMessage(senderJid, { text: settingsMsg }, { quoted: m });
            }
        });

        setTimeout(async () => {
            if (currentQR) {
                try {
                    const qrImage = await QRCode.toDataURL(currentQR);
                    res.json({ success: true, qrImage });
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
app.listen(PORT, () => console.log(`🚀 Bot server active on port ${PORT}`));
