import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import http from 'http';

// =========================
// CONFIG
// =========================
const LOG_DIR = './logs';
const LOG_FILE = `${LOG_DIR}/confirmacoes.txt`;

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR);

// =========================
// MEMÓRIA DE ESCALAS
// =========================
const escalasPendentes = {}; 
// userJid -> { grupo, loja, data, horario, nome }

// =========================
// BOT
// =========================
async function startBot() {

  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) qrcode.generate(qr, { small: true });

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
          : true;

      if (shouldReconnect) startBot();
    }

    if (connection === 'open') {
      console.log('✅ BOT CONECTADO');
    }
  });

  // =========================
  // MENSAGENS
  // =========================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

    const from = msg.key.remoteJid;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    const resposta = text.trim();

    // =========================
    // CONFIRMAÇÃO / RECUSA
    // =========================
    if (resposta === '1' || resposta === '2') {

      const userJid = from;

      if (!escalasPendentes[userJid]) {
        await sock.sendMessage(userJid, {
          text: '⚠️ Não há nenhuma escala pendente para confirmação.'
        });
        return;
      }

      const { grupo, loja, data, horario, nome } = escalasPendentes[userJid];

      const numeroLimpo = userJid.split('@')[0].replace('55', '');

      const dataHora = new Date().toISOString();

      if (resposta === '1') {
        // CONFIRMOU
        await sock.sendMessage(userJid, {
          text: '✅ Presença confirmada. Obrigado!'
        });

        await sock.sendMessage(grupo, {
          text: `✅ @${numeroLimpo} CONFIRMOU presença\n📅 ${data}\n🕒 ${horario}\n🏢 ${loja}`,
          mentions: [userJid]
        });

        fs.appendFileSync(LOG_FILE,
          `[${dataHora}] CONFIRMADO | ${numeroLimpo} | ${nome} | ${loja} | ${data} | ${horario}\n`
        );
      }

      if (resposta === '2') {
        // RECUSOU
        await sock.sendMessage(userJid, {
          text: '❌ Escala recusada. O supervisor será avisado.'
        });

        await sock.sendMessage(grupo, {
          text: `❌ @${numeroLimpo} RECUSOU a escala\n📅 ${data}\n🕒 ${horario}\n🏢 ${loja}`,
          mentions: [userJid]
        });

        fs.appendFileSync(LOG_FILE,
          `[${dataHora}] RECUSADO | ${numeroLimpo} | ${nome} | ${loja} | ${data} | ${horario}\n`
        );
      }

      delete escalasPendentes[userJid];
      return;
    }

    // =========================
    // /ON
    // =========================
    if (resposta === '/on') {
      await sock.sendMessage(from, { text: '🟢 Bot ativo' });
      return;
    }

    // =========================
    // /REGRAS
    // =========================
    if (resposta === '/regras') {
      await sock.sendMessage(from, {
        text: 
`📋 REGRAS DE USO DO SISTEMA DE ESCALAS

1️⃣ Envio da escala:
/escala DATA

2️⃣ Formato por linha:
@pessoa HORÁRIO

Exemplo:
/escala 28/01
@joao 12:00
@ana 13h30



4️⃣ A data pode conter texto livre:
Ex: 28/01 Quarta-feira
Ex: Escala Semana 01/02 a 07/02

5️⃣ Confirmação:
1️⃣ Confirmar presença
2️⃣ Recusar escala

🤖 Sistema automático de escalas.`
      });
      return;
    }

    // =========================
    // /ESCALA (2 FORMATOS)
    // =========================
    if (resposta.startsWith('/escala') || resposta.toLowerCase().startsWith('escala')) {

      const linhas = resposta.split('\n').map(l => l.trim()).filter(l => l !== '');

      // data
      let dataLinha = linhas[0];
      dataLinha = dataLinha.replace(/\/escala/i, '').replace(/escala/i, '').trim();
      const data = dataLinha || 'Data não informada';

      // Loja = nome do grupo
      let loja = 'Loja não identificada';
      let participantes = {};

      if (from.endsWith('@g.us')) {
        const meta = await sock.groupMetadata(from);
        loja = meta.subject;

        meta.participants.forEach(p => {
          participantes[p.id] = p.notify || p.name || 'Sem nome';
        });
      }

      const mentions =
        msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

      let idxMention = 0;
      let horarioAtual = null;

      const regexHorarioLinha = /^hor[aá]rio\s*(\d{1,2}:\d{2}|\d{1,2}h\d{0,2}|\d{1,2}h)/i;

      for (let i = 1; i < linhas.length; i++) {
        const linha = linhas[i];

        // Detecta "Horário X"
        const matchHorario = linha.match(regexHorarioLinha);
        if (matchHorario) {
          horarioAtual = matchHorario[1];
          continue;
        }

        let userJid = null;

        // MENÇÃO REAL
        if (mentions[idxMention]) {
          userJid = mentions[idxMention];
          idxMention++;
        }

        if (!userJid) continue;

        // Caso formato antigo: @pessoa 12:00
        let horario = horarioAtual;
        if (!horario) {
          const partes = linha.split(' ');
          horario = partes[partes.length - 1];
        }

        const nome = participantes[userJid] || 'Sem nome';

        escalasPendentes[userJid] = {
          grupo: from,
          loja,
          data,
          horario,
          nome
        };

        const mensagemPrivada =
`Olá 👋

Você foi escalado para trabalhar:

🏢 Loja: ${loja}
📅 Data: ${data}
🕒 Horário: ${horario}

🤖 Mensagem automática do sistema.

📌 Responda com:
1️⃣ Confirmar presença
2️⃣ Recusar escala

📢 Confirme para garantir sua vaga!`;

        await sock.sendMessage(userJid, { text: mensagemPrivada });

        const numeroLimpo = userJid.split('@')[0].replace('55', '');
        await sock.sendMessage(from, {
          text: `📨 @${numeroLimpo} escalado para ${data} às ${horario} (${loja})`,
          mentions: [userJid]
        });
      }
    }
  });
}

// =========================
// HTTP KEEP ALIVE (RENDER)
// =========================
const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot online');
}).listen(PORT, () => {
  console.log(`🌐 HTTP ativo na porta ${PORT}`);
});

// =========================
// START
// =========================
startBot();
