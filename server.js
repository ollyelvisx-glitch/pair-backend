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
let sock = null;

// Initialize WhatsApp Bot Globally on Server Start
async function startWhatsAppBot() {
    const sessionDir = path.join(__dirname, 'sessions', 'baileys_auth');

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr, lastDisconnect } = update;

        if (qr) {
            currentQR = qr;
            console.log('[+] New QR Code generated, ready to scan on web UI.');
        }

        if (connection === 'open') {
            console.log('[+] WhatsApp Bot successfully connected and listening!');
        } else if (connection === 'close') {
            console.log('[!] Connection closed. Reconnecting...');
            startWhatsAppBot(); // Auto-reconnect if connection drops
        }
    });

    // Global Message & Command Handler
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message) return;

        const senderJid = m.key.remoteJid;

        // 1. Extract text safely
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

        // 3. Command Handler
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
            await sock.sendMessage(settingsMsg, { text: settingsMsg }, { quoted: m });
        }
    });
}

// QR Endpoint just serves the active QR code to your frontend page
app.get('/qr', (req, res) => {
    if (currentQR) {
        QRCode.toDataURL(currentQR, (err, qrImage) => {
            if (err) {
                res.status(500).json({ error: "Failed to render QR image" });
            } else {
                res.json({ success: true, qrImage });
            }
        });
    } else {
        res.status(404).json({ error: "QR code not ready yet or already connected." });
    }
});

app.get('/ping', (req, res) => {
    res.json({ status: "online", time: Date.now() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server active on port ${PORT}`);
    startWhatsAppBot(); // Start the bot when the server boots up
});
