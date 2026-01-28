import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';

import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';

// =========================
// LOG
// =========================
const LOG_DIR = path.resolve('./logs');
const LOG_FILE = path.join(LOG_DIR, 'confirmacoes.txt');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '', 'utf8');

// =========================
// MEMÓRIA DE ESCALAS
// =========================
// userJid -> { grupo, loja, data, horario, nome }
const escalasPendentes = {};

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
  // FUNÇÃO LOG
  // =========================
  function registrarLog(tipo, numero, nome, loja, data, horario) {
    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').substring(0, 19);
    const linha = `[${timestamp}] ${tipo.padEnd(10)} | ${numero} | ${nome} | ${loja} | ${data} | ${horario}\n`;
    fs.appendFileSync(LOG_FILE, linha, 'utf8');
  }

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

      if (resposta === '1') {
        await sock.sendMessage(userJid, {
          text: '✅ Presença confirmada. Obrigado!'
        });

        await sock.sendMessage(grupo, {
          text: `✅ @${numeroLimpo} CONFIRMOU presença\n📅 ${data}\n🕒 ${horario}\n🏢 ${loja}`,
          mentions: [userJid]
        });

        registrarLog('CONFIRMADO', userJid.split('@')[0], nome, loja, data, horario);
      }

      if (resposta === '2') {
        await sock.sendMessage(userJid, {
          text: '❌ Escala recusada. O supervisor será avisado.'
        });

        await sock.sendMessage(grupo, {
          text: `❌ @${numeroLimpo} RECUSOU a escala\n📅 ${data}\n🕒 ${horario}\n🏢 ${loja}`,
          mentions: [userJid]
        });

        registrarLog('RECUSADO', userJid.split('@')[0], nome, loja, data, horario);
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

FORMATOS SUPORTADOS:

1️⃣ Formato tradicional:
@pessoa HORÁRIO

Ex:
@joao 16:00
@ana 18:00

2️⃣ Formato por blocos:

Horário 16:00
@joao

Horário 18:00
@ana
@jose

COMANDO:
/escala DATA
ou
Escala DATA

Confirmação:
1️⃣ Confirmar
2️⃣ Recusar

🤖 Sistema automático de escalas.`
      });
      return;
    }

    // =========================
    // /ESCALA  (2 FORMATOS)
    // =========================
    if (
      resposta.startsWith('/escala') ||
      resposta.toLowerCase().startsWith('escala')
    ) {

      const linhas = resposta.split('\n').map(l => l.trim()).filter(l => l !== '');

      // =========================
      // DATA
      // =========================
      let dataLinha = linhas[0];
      if (dataLinha.toLowerCase().startsWith('/escala')) {
        dataLinha = dataLinha.replace(/\/escala/i, '').trim();
      }
      if (dataLinha.toLowerCase().startsWith('escala')) {
        dataLinha = dataLinha.replace(/escala/i, '').trim();
      }
      const data = dataLinha || 'Data não informada';

      // =========================
      // LOJA
      // =========================
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

        // =========================
        // BLOCO "Horário X"
        // =========================
        const matchHorario = linha.match(regexHorarioLinha);
        if (matchHorario) {
          horarioAtual = matchHorario[1];
          continue;
        }

        let userJid = null;
        let horario = null;

        // =========================
        // FORMATO TRADICIONAL
        // =========================
        if (linha.includes('@') && linha.split(' ').length > 1) {
          const partes = linha.split(' ');
          horario = partes.pop();
        }

        // =========================
        // MENÇÃO
        // =========================
        if (mentions[idxMention]) {
          userJid = mentions[idxMention];
          idxMention++;
        }

        if (!userJid) continue;

        // =========================
        // DEFINE HORÁRIO
        // =========================
        if (!horario && horarioAtual) {
          horario = horarioAtual;
        }

        if (!horario) continue;

        const nome = participantes[userJid] || 'Sem nome';

        // =========================
        // SALVA ESCALA
        // =========================
        escalasPendentes[userJid] = {
          grupo: from,
          loja,
          data,
          horario,
          nome
        };

        // =========================
        // DM PRIVADO
        // =========================
        const mensagemPrivada =
`Olá 👋

Você foi escalado para trabalhar:

🏢 Loja: ${loja}
📅 Data: ${data}
🕒 Horário: ${horario}

🤖 Mensagem automática do sistema.

📌 Responda com numero:
1️⃣ Confirmar presença
2️⃣ Recusar escala

📢 Confirme para garantir sua vaga!`;

        await sock.sendMessage(userJid, { text: mensagemPrivada });

        // =========================
        // AVISO NO GRUPO
        // =========================
        const numeroLimpo = userJid.split('@')[0].replace('55', '');
        await sock.sendMessage(from, {
          text: `📨 @${numeroLimpo} escalado para ${data} às ${horario} (${loja})`,
          mentions: [userJid]
        });
      }
    }
  });
}

startBot();
