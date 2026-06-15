const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require('crypto');

const app = express();

const corsOptions = {
    origin: true,
    methods: ['GET','POST','PUT','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-token'],
};
app.use(cors(corsOptions));
app.use(express.json());

app.get('/', (req, res) => {
    res.json({ status: 'ok' });
});

// Handle invalid JSON bodies so the server doesn't crash
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ message: 'JSON inválido no corpo da requisição' });
    }
    next(err);
});

const DATA_FILE = path.join(__dirname, 'agenda.json');
let agenda = [];

// Optional admin phone for notifications (international format, digits only preferred)
// For testing we default to the provided admin number. In production, prefer setting ADMIN_PHONE as an env var.
const ADMIN_PHONE = process.env.ADMIN_PHONE || '51995345142';

function digitsOnly(v) {
    return (v || '').toString().replace(/\D/g, '');
}

function makeWaMeLink(phone, text) {
    const p = digitsOnly(phone);
    if (!p) return null;
    return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}

function recordNotification(obj) {
    try {
        const logPath = path.join(__dirname, 'notifications.log');
        fs.appendFileSync(logPath, JSON.stringify(obj) + '\n', 'utf8');
    } catch (err) {
        console.error('Erro ao gravar notifications.log', err);
    }
}

function loadAgenda() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const raw = fs.readFileSync(DATA_FILE, 'utf8');
            agenda = JSON.parse(raw || '[]');
            // ensure every item has an id for delete operations
            let changed = false;
            agenda = agenda.map(item => {
                if (!item.id) {
                    item.id = (item.createdAt ? new Date(item.createdAt).getTime() : Date.now()).toString() + '-' + Math.random().toString(36).slice(2,6);
                    changed = true;
                }
                return item;
            });
            if (changed) saveAgenda();
        }
    } catch (err) {
        console.error('Erro ao ler agenda.json:', err);
        agenda = [];
    }
}

function saveAgenda() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(agenda, null, 2), 'utf8');
    } catch (err) {
        console.error('Erro ao salvar agenda.json:', err);
    }
}

loadAgenda();

// Admin token (use env var in production)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'adm123';

function isAdmin(req) {
    const header = req.header('x-admin-token');
    const q = req.query?.token;
    return header === ADMIN_TOKEN || q === ADMIN_TOKEN;
}

// Only admin can list saved appointments
app.get('/agenda', (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    // ensure every item has an id
    let changed = false;
    agenda = agenda.map(item => {
        if (!item.id) {
            item.id = (item.createdAt ? new Date(item.createdAt).getTime() : Date.now()).toString() + '-' + Math.random().toString(36).slice(2,6);
            changed = true;
        }
        return item;
    });
    if (changed) saveAgenda();
    res.json(agenda);
});

// Public endpoint to create an appointment
app.post('/agenda', (req, res) => {
    const entry = req.body || {};
    // minimal validation
    if (!entry.nome || !entry.servico || !entry.horario) {
        return res.status(400).json({ message: 'Dados incompletos. Envie nome, servico e horario.' });
    }
    entry.createdAt = new Date().toISOString();
    entry.status = 'Pendente';
    entry.id = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString() + '-' + Math.random().toString(36).slice(2,6));
    agenda.push(entry);
    saveAgenda();
    
    // Notify admin via wa.me link if ADMIN_PHONE configured
    try {
        if (ADMIN_PHONE) {
            const adminMsg = `Novo agendamento: ${entry.nome} - ${entry.servico} - ${entry.horario} - Contato: ${entry.telefone || entry.contact || ''}`;
            const waAdmin = makeWaMeLink(ADMIN_PHONE, adminMsg);
            const note = { to: ADMIN_PHONE, via: 'wa.me', url: waAdmin, message: adminMsg, type: 'admin-alert', createdAt: new Date().toISOString(), entryId: entry.id };
            recordNotification(note);
            entry.adminNotification = note;
        }
    } catch (err) {
        console.error('Erro ao tentar notificar admin:', err);
    }

    res.json({ message: 'Agendamento salvo 👊', entry });
});

app.get('/teste', (req, res) => {
    agenda.push({
        nome: 'isaac',
        serviço: 'corte de cabelo',
        horario: '10:00',
        id: crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString() + '-' + Math.random().toString(36).slice(2,6)),
        createdAt: new Date().toISOString()
    });
    saveAgenda();
    res.json({ message: 'Agendamento Criado com Sucesso' });
});

// DELETE appointment by id (admin only)
app.delete('/agenda/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ message: 'Unauthorized' });
    const id = req.params.id;
    const idx = agenda.findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Agendamento não encontrado' });
    const removed = agenda.splice(idx, 1)[0];
    saveAgenda();
    res.json({ message: 'Agendamento removido', removed });
});

// UPDATE appointment by id (admin only)
app.put('/agenda/:id', (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ message: 'Unauthorized' });
    const id = req.params.id;
    const idx = agenda.findIndex(a => a.id === id);
    if (idx === -1) return res.status(404).json({ message: 'Agendamento não encontrado' });
    const updates = req.body || {};
    const allowed = ['nome', 'servico', 'horario', 'telefone', 'obs', 'status'];
    Object.keys(updates).forEach(k => {
        if (allowed.includes(k)) {
            agenda[idx][k] = updates[k];
        }
    });
    agenda[idx].updatedAt = new Date().toISOString();
    saveAgenda();

    // If status changed to Confirmado or Recusado, prepare client notification link (wa.me)
    try {
        if (updates.status && (updates.status === 'Confirmado' || updates.status === 'Recusado')) {
            const item = agenda[idx];
            const clientPhone = item.telefone || item.contact || '';
            const statusText = updates.status;
            const clientMsg = `Olá ${item.nome || ''}, seu agendamento para ${item.servico || ''} em ${item.horario || ''} foi ${statusText}. Obrigada, Riti.`;
            const waClient = makeWaMeLink(clientPhone, clientMsg);
            const note = { to: clientPhone, via: 'wa.me', url: waClient, message: clientMsg, type: 'client-status', status: statusText, createdAt: new Date().toISOString(), entryId: item.id };
            recordNotification(note);
            item.clientNotification = note;
            saveAgenda();
        }
    } catch (err) {
        console.error('Erro ao tentar notificar cliente:', err);
    }
    res.json({ message: 'Agendamento atualizado', entry: agenda[idx] });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});