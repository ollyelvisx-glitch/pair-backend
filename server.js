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

// 🧠 In-Memory Message Store Cache (Keeps the last 500 messages so we can look them up by ID)
const messageStore = new Map();

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
        const { connection, qr } = update;

        if (qr) {
            currentQR = qr;
            console.log('[+] New QR Code generated, ready to scan on web UI.');
        }

        if (connection === 'open') {
            console.log('[+] WhatsApp Bot successfully connected and listening!');
        } else if (connection === 'close') {
            console.log('[!] Connection closed. Reconnecting...');
            startWhatsAppBot();
        }
    });

    // 1️⃣ Cache every incoming message into memory store
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const m = messages[0];
        if (!m.message) return;

        // Save raw message to map using its unique stanza ID
        if (m.key && m.key.id) {
            messageStore.set(m.key.id, m);
            // Keep map size clean by trimming old messages if it exceeds 500 items
            if (messageStore.size > 500) {
                const firstKey = messageStore.keys().next().value;
                messageStore.delete(firstKey);
            }
        }

        const senderJid = m.key.remoteJid;

        // Extract text safely
        const text = m.message.conversation || 
                     m.message.extendedTextMessage?.text || 
                     m.message.imageMessage?.caption || 
                     m.message.videoMessage?.caption || '';

        console.log(`[Incoming] From ${senderJid}: "${text}"`);

        if (!text.startsWith('.')) return;

        const command = text.slice(1).trim().split(' ')[0].toLowerCase();
        console.log(`[Command Triggered] -> ${command}`);

        if (command === 'ping') {
            await sock.sendMessage(senderJid, { text: 'Pong! Bot is online and listening 🟢' }, { quoted: m });
        } 
        else if (command === 'settings' || command === 'setting') {
            const settingsMsg = 
                `⚙️ *BOT SETTINGS PANEL* ⚙️\n\n` +
                `• *Prefix:* .\n` +
                `• *Anti-View Once (.vv2):* Active 🟢\n` +
                `• *Status:* Connected & Responsive`;
            await sock.sendMessage(senderJid, { text: settingsMsg }, { quoted: m });
        }
        // 2️⃣ Robust .vv2 Command Handler using Message Store Cache
        else if (command === 'vv2' || command === 'vv') {
            const contextInfo = m.message?.extendedTextMessage?.contextInfo;
            const quotedId = contextInfo?.stanzaId;
            
            if (!quotedId) {
                await sock.sendMessage(senderJid, { text: '❌ Please reply to a View-Once message with .vv2' }, { quoted: m });
                return;
            }

            // Look up the original raw message from our memory cache!
            const originalMessage = messageStore.get(quotedId);

            if (!originalMessage) {
                await sock.sendMessage(senderJid, { text: '❌ Original message not found in bot cache. Try again on a newer message.' }, { quoted: m });
                return;
            }

            // Extract the core view-once object from the cached original message
            const quotedMsgContainer = originalMessage.message;
            let mediaMessage = 
                quotedMsgContainer?.viewOnceMessage?.message || 
                quotedMsgContainer?.viewOnceMessageV2?.message;

            if (!mediaMessage) {
                await sock.sendMessage(senderJid, { text: '❌ The replied message is not a valid View-Once media.' }, { quoted: m });
                return;
            }

            try {
                // Download using the original cached raw message object (which has all decryption keys intact)
                const buffer = await downloadMediaMessage(
                    originalMessage,
                    'buffer',
                    {},
                    { logger: sock.logger, reuploadRequest: sock.updateMediaMessage }
                );

                const myNumber = sock.user.id.split(':')[0] + '@s.whatsapp.net';

                if (mediaMessage.videoMessage) {
                    await sock.sendMessage(myNumber, {
                        video: buffer,
                        caption: `🔓 *Unlocked View-Once Video* via .vv2`
                    });
                } else if (mediaMessage.imageMessage) {
                    await sock.sendMessage(myNumber, {
                        image: buffer,
                        caption: `🔓 *Unlocked View-Once Image* via .vv2`
                    });
                }
                console.log(`[+] .vv2 successfully decrypted and forwarded media from cache!`);
            } catch (err) {
                console.error("[CRITICAL DOWNLOAD ERROR]:", err);
                await sock.sendMessage(senderJid, { text: `❌ Download Error: ${err.message}` }, { quoted: m });
            }
        }
    });
}

// Server Endpoints
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
    startWhatsAppBot();
});
