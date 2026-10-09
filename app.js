(function () {
  'use strict';

  // ---------- utilidades ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + (Number(n) || 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const mmss = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const initials = (n) => String(n || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
  const rand = (a, b) => a + Math.random() * (b - a);
  const hhmm = (ms) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  const hhmmss = (ms) => new Date(ms).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  function when(ms) {
    const d = new Date(ms), today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Hoy ' + hhmm(ms);
    return d.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }) + ' ' + hhmm(ms);
  }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 3000);
  }
  function showError(msg) { const g = $('globalError'); g.textContent = msg; g.hidden = !msg; }
  function fbError(e) {
    if (e && e.code === 'permission-denied') return 'Firestore rechazó el acceso. Revisa que publicaste las reglas de crm/firestore.rules en la consola de Firebase.';
    return (e && e.message) || String(e);
  }

  const STATUS = {
    pendiente: { label: 'Pendiente', cls: '' },
    marcando: { label: 'Marcando', cls: 'ok' },
    en_llamada: { label: 'En llamada', cls: 'ok' },
    rellamar: { label: 'Volver a llamar', cls: '' },
    promesa: { label: 'Promesa de pago', cls: 'ok' },
    no_interesado: { label: 'No interesado', cls: 'warn' },
    equivocado: { label: 'Número equivocado', cls: 'warn' },
    agotado: { label: 'Intentos agotados', cls: 'warn' }
  };
  const DISP_LABEL = { promesa: 'Promesa de pago', rellamar: 'Volver a llamar', no_interesado: 'No interesado', equivocado: 'Número equivocado', buzon: 'Se cortó / buzón' };
  const MAX_ATTEMPTS = 3;
  const RETRY_MS = 3 * 60 * 1000;
  const ONLINE_MS = 60 * 1000;     // un agente sin latido en este tiempo se considera desconectado
  const ENGINE_STALE_MS = 20 * 1000;
  const BOT_NAMES = ['Ana Ramírez', 'Luis Martínez', 'Sofía Hernández', 'Jorge Castillo', 'Paola Ruiz', 'Diego Navarro', 'Carmen Ortiz'];

  // ---------- Firebase ----------
  const CFG = window.FIREBASE_CONFIG;
  if (!CFG || !CFG.apiKey || CFG.apiKey.startsWith('TU_')) {
    $('authScreen').hidden = false;
    $('authError').textContent = 'Falta la configuración de Firebase. Pega la de tu proyecto en firebase-config.js y recarga.';
    $('authError').hidden = false;
    $('authSubmit').disabled = true;
    return;
  }
  firebase.initializeApp(CFG);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const FV = firebase.firestore.FieldValue;
  const inc = (n) => FV.increment(n);
  const AG = db.collection('crm_agents');
  const CT = db.collection('crm_contacts');
  const CAMP = db.collection('crm_campaign').doc('main');

  const DEFAULT_CAMP = () => ({
    cfg: { mode: 'predictivo', target: 3, maxRatio: 3, running: true, bots: 0 },
    stats: { dialed: 0, human: 0, machine: 0, noanswer: 0, connected: 0, abandoned: 0 },
    buckets: {}, ratio: 1, log: [], engine: null
  });

  let uid = null, me = null, agents = [], contacts = [], camp = null, campLoaded = false;
  let unsubs = [], beatTimer = null, uiTimer = null, pendingProfile = null;
  const contactById = (id) => contacts.find((c) => c.id === id);
  const isSup = () => me && me.role === 'supervisor';

  // ---------- login ----------
  let registering = false;
  function setAuthMode(reg) {
    registering = reg;
    $('authTitle').textContent = reg ? 'Crear cuenta' : 'Iniciar sesión';
    $('authSubmit').textContent = reg ? 'Crear cuenta' : 'Entrar';
    $('registerFields').hidden = !reg;
    $('authSwitchText').textContent = reg ? '¿Ya tienes cuenta?' : '¿No tienes cuenta?';
    $('authSwitch').textContent = reg ? 'Iniciar sesión' : 'Crear cuenta';
    $('aPass').autocomplete = reg ? 'new-password' : 'current-password';
    $('authError').hidden = true;
  }
  $('authSwitch').addEventListener('click', () => setAuthMode(!registering));
  const AUTH_MSG = {
    'auth/invalid-email': 'El correo no es válido.',
    'auth/user-not-found': 'No hay una cuenta con ese correo.',
    'auth/wrong-password': 'Correo o contraseña incorrectos.',
    'auth/invalid-credential': 'Correo o contraseña incorrectos.',
    'auth/invalid-login-credentials': 'Correo o contraseña incorrectos.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese correo. Inicia sesión.',
    'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
    'auth/operation-not-allowed': 'Activa “Correo electrónico/contraseña” en Firebase Console → Authentication → Método de acceso.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.'
  };
  $('authForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('aEmail').value.trim(), pass = $('aPass').value;
    const err = $('authError'); err.hidden = true;
    if (registering && !$('aName').value.trim()) { err.textContent = 'Escribe tu nombre.'; err.hidden = false; return; }
    $('authSubmit').disabled = true;
    try {
      if (registering) {
        pendingProfile = { name: $('aName').value.trim(), role: $('aRole').value };
        await auth.createUserWithEmailAndPassword(email, pass);
      } else {
        await auth.signInWithEmailAndPassword(email, pass);
      }
    } catch (ex) {
      pendingProfile = null;
      err.textContent = AUTH_MSG[ex.code] || ex.message; err.hidden = false;
    } finally { $('authSubmit').disabled = false; }
  });

  function newProfile(name, role) {
    return { name, role, bot: false, state: 'pausa', since: Date.now(), contactId: null, calls: 0, talk: 0, promises: 0, promAmt: 0, beat: Date.now() };
  }
  $('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('pName').value.trim();
    if (!name) return;
    try { await AG.doc(uid).set(newProfile(name, $('pRole').value)); enterApp(); }
    catch (ex) { $('profileError').textContent = fbError(ex); $('profileError').hidden = false; }
  });

  auth.onAuthStateChanged(async (user) => {
    stopListeners();
    if (!user) { uid = null; me = null; $('appScreen').hidden = true; $('profileScreen').hidden = true; $('authScreen').hidden = false; return; }
    uid = user.uid;
    try {
      const snap = await AG.doc(uid).get();
      if (!snap.exists) {
        if (pendingProfile) { await AG.doc(uid).set(newProfile(pendingProfile.name, pendingProfile.role)); pendingProfile = null; }
        else { $('authScreen').hidden = true; $('profileScreen').hidden = false; return; }
      }
      enterApp();
    } catch (ex) {
      $('authScreen').hidden = false;
      $('authError').textContent = fbError(ex); $('authError').hidden = false;
    }
  });

  $('btnLogout').addEventListener('click', async () => {
    if (E.on) await stopEngine();
    try { await AG.doc(uid).update({ state: 'pausa', since: Date.now() }); } catch (e) { /* sin conexión */ }
    auth.signOut();
  });
  window.addEventListener('beforeunload', () => {
    if (E.on) { CAMP.update({ engine: null }).catch(() => {}); }
    if (me && me.state === 'libre') AG.doc(uid).update({ state: 'pausa', since: Date.now() }).catch(() => {});
  });

  // ---------- datos en vivo ----------
  function stopListeners() { unsubs.forEach((u) => u()); unsubs = []; clearInterval(beatTimer); clearInterval(uiTimer); }
  function enterApp() {
    $('authScreen').hidden = true; $('profileScreen').hidden = true; $('appScreen').hidden = false;
    const onErr = (ex) => showError(fbError(ex));
    unsubs.push(AG.onSnapshot((s) => {
      agents = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      me = agents.find((a) => a.id === uid) || me;
      if (campLoaded && !camp && isSup()) CAMP.set(DEFAULT_CAMP()).catch(onErr);
      onMeChange(); renderAll();
    }, onErr));
    unsubs.push(CT.onSnapshot((s) => {
      contacts = s.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (shownContactId) fillCustomer(contactById(shownContactId));
      renderAll();
    }, onErr));
    unsubs.push(CAMP.onSnapshot((s) => {
      camp = s.exists ? s.data() : null; campLoaded = true;
      if (!s.exists && isSup()) CAMP.set(DEFAULT_CAMP()).catch(onErr);
      if (E.on && camp && camp.engine && camp.engine.uid !== uid) { stopEngine(true); toast('Otro supervisor tomó el control del motor.'); }
      renderControls(); renderAll();
    }, onErr));
    beatTimer = setInterval(() => { AG.doc(uid).update({ beat: Date.now() }).catch(() => {}); }, 20000);
    AG.doc(uid).update({ beat: Date.now() }).catch(onErr);
    uiTimer = setInterval(renderAll, 1000);
    let start = 'agente';
    try { start = localStorage.getItem('c360_view') || 'agente'; } catch (e) {}
    show(start);
  }

  // ---------- vista del agente ----------
  let shownContactId = null, muted = false, held = false;
  function onMeChange() {
    if (!me) return;
    $('meName').textContent = me.name; $('meRole').textContent = me.role === 'supervisor' ? 'Supervisor' : 'Agente';
    $('tab-supervisor').hidden = !isSup();
    if (!isSup() && currentView === 'supervisor') show('agente');
    const onCall = me.state === 'llamada' || me.state === 'tipificando';
    if (onCall && me.contactId && me.contactId !== shownContactId) {
      shownContactId = me.contactId; muted = false; held = false;
      const c = contactById(me.contactId);
      fillCustomer(c); resetForm(c);
      if (me.state === 'llamada' && currentView !== 'agente') { $('tabDot').hidden = false; toast('Llamada conectada' + (c ? ': ' + c.name : '')); }
    }
    if (!onCall) shownContactId = null;
  }
  function fillCustomer(c) {
    if (!c) return;
    $('cAvatar').textContent = initials(c.name);
    $('cName').textContent = c.name;
    $('cMeta').textContent = 'Cliente ' + (c.folio || c.id) + (c.segment ? ' · Segmento ' + c.segment : '');
    $('cChips').innerHTML = (c.daysLate ? '<span class="chip warn">Atraso ' + esc(c.daysLate) + ' días</span>' : '') + (c.balance > 10000 ? '<span class="chip">Saldo alto</span>' : '');
    $('cBalance').textContent = money(c.balance); $('cMin').textContent = money(c.minPay);
    $('cLate').textContent = c.daysLate || 0; $('cAttempt').textContent = (c.attempts || 0) + ' de ' + MAX_ATTEMPTS;
    $('sName').textContent = c.name; $('sBal').textContent = money(c.balance); $('sLate').textContent = c.daysLate || 0; $('sMin').textContent = money(c.minPay);
    $('cHistory').innerHTML = historyHtml(c, 6);
  }
  function historyHtml(c, n) {
    const h = (c.history || []).slice().sort((a, b) => b.t - a.t).slice(0, n);
    return h.map((x) => '<li><span class="tdot"></span><div><div class="tt">' + esc(x.title) + '</div><div class="tm">' + when(x.t) + ' · ' + esc(x.by) + '</div></div></li>').join('') || '<li class="sub">Sin interacciones.</li>';
  }
  function resetForm(c) {
    $('dispForm').reset();
    $('pAmount').value = c ? money(c.minPay) : '';
    const d = new Date(); d.setDate(d.getDate() + 3); $('pDate').value = d.toISOString().slice(0, 10);
    $('promiseFields').hidden = true; $('callbackFields').hidden = true; $('dispError').hidden = true;
  }
  function engineActive() { return !!(camp && camp.engine && Date.now() - camp.engine.beat < ENGINE_STALE_MS); }

  function renderAgent() {
    if (!me) return;
    const c = me.contactId ? contactById(me.contactId) : null;
    const elapsed = (Date.now() - (me.since || Date.now())) / 1000;
    const map = { pausa: ['En pausa', 'warn'], libre: ['Disponible', 'ok'], llamada: ['En llamada ' + mmss(elapsed), 'ok'], tipificando: ['Tipificando', ''] };
    const st = map[me.state] || map.pausa;
    $('myStateText').textContent = st[0]; $('myStateChip').className = 'chip ' + st[1];
    $('phoneNumber').textContent = c ? c.phone : '—';
    $('phoneSub').textContent = me.state === 'llamada' ? 'Contestó una persona (AMD) · ' + (held ? 'en espera' : muted ? 'micrófono silenciado' : 'audio simulado')
      : me.state === 'tipificando' ? 'Llamada terminada. Guarda el resultado para recibir la siguiente.'
      : me.state === 'libre' ? 'El marcador está marcando por ti.' : 'No estás recibiendo llamadas.';
    $('callCtrls').hidden = me.state !== 'llamada'; $('btnHang').hidden = me.state !== 'llamada';
    $('btnAvail').hidden = me.state !== 'pausa'; $('btnPause').hidden = me.state !== 'libre';
    $('btnMute').classList.toggle('on', muted); $('btnMute').setAttribute('aria-pressed', muted); $('btnMute').textContent = muted ? 'Silenciado' : 'Silenciar';
    $('btnHold').classList.toggle('on', held); $('btnHold').setAttribute('aria-pressed', held); $('btnHold').textContent = held ? 'En espera' : 'Retener';
    const onCall = me.state === 'llamada' || me.state === 'tipificando';
    $('idlePanel').hidden = onCall; $('customerPanel').hidden = !onCall;
    $('dispSet').disabled = !onCall;
    $('dispHint').textContent = me.state === 'llamada' ? 'Puedes ir eligiendo el resultado mientras hablas.'
      : me.state === 'tipificando' ? 'Elige el resultado y guarda; se registra en el CRM.' : 'Disponible cuando estés en una llamada.';
    if (!onCall) {
      const running = engineActive() && camp.cfg.running;
      $('idleTitle').textContent = me.state === 'pausa' ? 'Estás en pausa' : 'Esperando la siguiente llamada…';
      $('idleText').textContent = me.state === 'pausa'
        ? 'Pulsa “Ponerme disponible”. El marcador predictivo marcará por ti y solo te pasará llamadas contestadas por una persona, con la ficha del cliente ya abierta.'
        : !engineActive() ? 'El marcador está detenido. Un supervisor debe iniciarlo desde la pestaña Supervisor.'
        : !camp.cfg.running ? 'El supervisor pausó la campaña. No se están marcando números.'
        : 'El marcador está llamando a la lista. En cuanto alguien conteste, se te conecta.';
      $('idlePulse').classList.toggle('anim', me.state === 'libre' && running);
    }
    $('myCalls').textContent = me.calls || 0;
    $('myAht').textContent = me.calls ? mmss(me.talk / me.calls) : '0:00';
    $('myPromises').textContent = me.promises || 0;
    $('myPromAmt').textContent = money(me.promAmt || 0).replace('.00', '');
  }

  function act(p) { p.catch((ex) => toast(fbError(ex))); }
  $('btnAvail').addEventListener('click', () => { act(AG.doc(uid).update({ state: 'libre', since: Date.now(), beat: Date.now() })); toast('Disponible. El marcador te pasará llamadas.'); });
  $('btnPause').addEventListener('click', () => act(AG.doc(uid).update({ state: 'pausa', since: Date.now() })));
  $('btnMute').addEventListener('click', () => { muted = !muted; renderAgent(); });
  $('btnHold').addEventListener('click', () => { held = !held; renderAgent(); });
  $('btnTransfer').addEventListener('click', () => toast('Transferencia simulada: con telefonía real va a otra extensión o cola.'));
  $('btnHang').addEventListener('click', () => {
    const now = Date.now();
    act(AG.doc(uid).update({ state: 'tipificando', since: now, calls: inc(1), talk: inc((now - me.since) / 1000) }));
  });
  document.querySelectorAll('input[name="disp"]').forEach((r) => r.addEventListener('change', () => {
    const v = document.querySelector('input[name="disp"]:checked').value;
    $('promiseFields').hidden = v !== 'promesa'; $('callbackFields').hidden = v !== 'rellamar'; $('dispError').hidden = true;
  }));

  // Cambios que una tipificación hace sobre el cliente (los usan agentes y agentes virtuales)
  function dispositionUpdate(c, d, extra, by) {
    const now = Date.now(); const hist = []; const u = {};
    if (d === 'promesa') { u.status = 'promesa'; u.promise = { amount: extra.amount, date: extra.date || '' }; hist.push({ t: now, title: 'Promesa de pago · ' + money(extra.amount), by }); }
    else if (d === 'rellamar') { u.status = 'rellamar'; u.nextAt = now + extra.mins * 60000; u.attempts = Math.max(0, (c.attempts || 1) - 1); hist.push({ t: now, title: 'Volver a llamar · en ' + extra.mins + ' min', by }); }
    else if (d === 'buzon') { Object.assign(u, retryFields(c)); hist.push({ t: now, title: 'Se cortó' + (u.status === 'agotado' ? ' · intentos agotados' : ' · se reintenta'), by }); }
    else { u.status = d; hist.push({ t: now, title: DISP_LABEL[d], by }); }
    if (extra.notes) hist.push({ t: now + 1, title: 'Nota: ' + extra.notes, by });
    u.history = FV.arrayUnion.apply(null, hist);
    return u;
  }
  function retryFields(c) {
    return (c.attempts || 0) >= MAX_ATTEMPTS ? { status: 'agotado' } : { status: 'pendiente', nextAt: Date.now() + RETRY_MS };
  }

  $('dispForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const sel = document.querySelector('input[name="disp"]:checked');
    if (!sel) { $('dispError').hidden = false; return; }
    const c = contactById(me.contactId); if (!c) return;
    const now = Date.now();
    const amount = parseFloat($('pAmount').value.replace(/[^0-9.]/g, '')) || c.minPay || 0;
    const batch = db.batch();
    batch.update(CT.doc(c.id), dispositionUpdate(c, sel.value, { amount, date: $('pDate').value, mins: +$('cbMins').value, notes: $('dNotes').value.trim() }, me.name));
    const mu = { state: 'libre', since: now, contactId: null };
    if (me.state === 'llamada') { mu.calls = inc(1); mu.talk = inc((now - me.since) / 1000); }
    if (sel.value === 'promesa') { mu.promises = inc(1); mu.promAmt = inc(amount); }
    batch.update(AG.doc(uid), mu);
    $('btnSave').disabled = true;
    try { await batch.commit(); toast('Guardado en el CRM: ' + DISP_LABEL[sel.value]); }
    catch (ex) { toast(fbError(ex)); }
    finally { $('btnSave').disabled = false; }
  });

  // ---------- motor de marcación (corre en la pestaña de un supervisor) ----------
  const E = { on: false, timer: null, calls: [], log: [], adj: 1, ratio: 1, lastFlush: 0, busyAgents: new Set(), pend: null };
  function freshPend() { return { stats: { dialed: 0, human: 0, machine: 0, noanswer: 0, connected: 0, abandoned: 0 }, buckets: {} }; }
  function elog(text, kind) { E.log.unshift({ t: Date.now(), text, kind: kind || '' }); if (E.log.length > 40) E.log.length = 40; }
  const bucketKey = (ms) => String(Math.floor(ms / 60000));
  function pendBucket(field) { const k = bucketKey(Date.now()); const b = E.pend.buckets[k] || (E.pend.buckets[k] = { conn: 0, ab: 0 }); b[field]++; }
  function totalStat(k) { return ((camp && camp.stats && camp.stats[k]) || 0) + (E.pend ? E.pend.stats[k] : 0); }
  function contactRate() { return (totalStat('human') + 3) / (totalStat('dialed') + 10); }
  function bucketsMerged() {
    const out = {}; const src = (camp && camp.buckets) || {};
    Object.keys(src).forEach((k) => { out[k] = { conn: src[k].conn || 0, ab: src[k].ab || 0 }; });
    if (E.pend) Object.keys(E.pend.buckets).forEach((k) => { const b = out[k] || (out[k] = { conn: 0, ab: 0 }); b.conn += E.pend.buckets[k].conn; b.ab += E.pend.buckets[k].ab; });
    return out;
  }
  function recentAband() {
    const b = bucketsMerged(); const k = Math.floor(Date.now() / 60000); let c = 0, a = 0;
    for (let i = k - 2; i <= k; i++) { const x = b[i]; if (x) { c += x.conn; a += x.ab; } }
    return c + a ? (a / (c + a)) * 100 : 0;
  }
  function isOnline(a, now) { return a.bot || now - (a.beat || 0) < ONLINE_MS; }
  function freeAgents(now) {
    return agents.filter((a) => a.state === 'libre' && isOnline(a, now) && !E.busyAgents.has(a.id)).sort((a, b) => (a.since || 0) - (b.since || 0));
  }

  async function startEngine() {
    try {
      await db.runTransaction(async (tx) => {
        const s = await tx.get(CAMP);
        const eng = s.exists && s.data().engine;
        if (eng && eng.uid !== uid && Date.now() - eng.beat < ENGINE_STALE_MS) throw new Error('busy:' + eng.name);
        if (!s.exists) tx.set(CAMP, DEFAULT_CAMP());
        tx.set(CAMP, { engine: { uid, name: me.name, beat: Date.now() } }, { merge: true });
      });
    } catch (ex) {
      toast(String(ex.message).startsWith('busy:') ? 'El motor ya está activo en la pestaña de ' + ex.message.slice(5) + '.' : fbError(ex));
      return;
    }
    E.on = true; E.calls = []; E.pend = freshPend(); E.log = ((camp && camp.log) || []).slice(0, 40); E.adj = 1; E.lastFlush = Date.now();
    // Limpia clientes que quedaron a medias si un motor anterior se cerró sin avisar
    const assigned = new Set(agents.map((a) => a.contactId).filter(Boolean));
    const stuck = contacts.filter((c) => c.status === 'marcando' || (c.status === 'en_llamada' && !assigned.has(c.id)));
    if (stuck.length) { const b = db.batch(); stuck.slice(0, 450).forEach((c) => b.update(CT.doc(c.id), { status: 'pendiente' })); b.commit().catch(() => {}); }
    elog('Motor iniciado por ' + me.name, 'ok');
    E.timer = setInterval(engineTick, 1000);
    renderControls(); flush(true);
  }
  async function stopEngine(silent) {
    clearInterval(E.timer); E.on = false;
    const b = db.batch(); let n = 0;
    E.calls.forEach((call) => { b.update(CT.doc(call.contactId), { status: 'pendiente' }); n++; });
    E.calls = [];
    if (n) await b.commit().catch(() => {});
    if (!silent) { elog('Motor detenido por ' + me.name, 'warn'); await flush(true); await CAMP.update({ engine: null }).catch(() => {}); }
    renderControls();
  }
  async function flush(force) {
    const now = Date.now();
    if (!force && now - E.lastFlush < 3000) return;
    E.lastFlush = now;
    const p = E.pend; E.pend = freshPend();
    const u = { 'engine.beat': now, 'engine.uid': uid, 'engine.name': me.name, ratio: Math.round(E.ratio * 10) / 10, log: E.log.slice(0, 40) };
    Object.keys(p.stats).forEach((k) => { if (p.stats[k]) u['stats.' + k] = inc(p.stats[k]); });
    Object.keys(p.buckets).forEach((k) => { u['buckets.' + k + '.conn'] = inc(p.buckets[k].conn); u['buckets.' + k + '.ab'] = inc(p.buckets[k].ab); });
    try { await CAMP.update(u); } catch (ex) { showError(fbError(ex)); }
  }

  function dial(c) {
    const r = Math.random();
    const outcome = r < 0.34 ? 'human' : r < 0.52 ? 'machine' : 'noanswer';
    E.calls.push({ contactId: c.id, phase: 'ringing', end: Date.now() + rand(3000, 10000), outcome });
    E.pend.stats.dialed++;
    CT.doc(c.id).update({ status: 'marcando', attempts: inc(1) }).catch(() => {});
  }
  function finishNoContact(call, why) {
    const c = contactById(call.contactId); if (!c) return;
    const u = retryFields(c);
    u.history = FV.arrayUnion({ t: Date.now(), title: why + (u.status === 'agotado' ? ' · intentos agotados' : ' · se reintenta'), by: 'Marcador' });
    CT.doc(c.id).update(u).catch(() => {});
  }
  async function assign(call, a) {
    const now = Date.now(); const c = contactById(call.contactId);
    try {
      const ok = await db.runTransaction(async (tx) => {
        const s = await tx.get(AG.doc(a.id));
        if (!s.exists || s.data().state !== 'libre') return false;
        const u = { state: 'llamada', since: now, contactId: call.contactId };
        if (a.bot) u.talkEnd = now + rand(25000, 70000);
        tx.update(AG.doc(a.id), u);
        tx.update(CT.doc(call.contactId), { status: 'en_llamada', history: FV.arrayUnion({ t: now, title: 'Llamada conectada con ' + a.name, by: 'Marcador predictivo' }) });
        return true;
      });
      if (ok) { E.pend.stats.connected++; pendBucket('conn'); elog((c ? c.name : 'Cliente') + ' contestó → conectado con ' + a.name, 'ok'); }
      return ok;
    } catch (ex) { return false; }
  }
  function botFinish(a) {
    const now = Date.now(); const c = contactById(a.contactId);
    const r = Math.random();
    const d = r < 0.35 ? 'promesa' : r < 0.6 ? 'rellamar' : r < 0.9 ? 'no_interesado' : 'equivocado';
    const b = db.batch();
    if (c) b.update(CT.doc(c.id), dispositionUpdate(c, d, { amount: c.minPay || 0, mins: 5, notes: '' }, a.name));
    const au = { state: 'tipificando', since: now, wrapEnd: now + rand(5000, 12000), calls: inc(1), talk: inc((now - a.since) / 1000) };
    if (d === 'promesa' && c) { au.promises = inc(1); au.promAmt = inc(c.minPay || 0); }
    b.update(AG.doc(a.id), au);
    b.commit().catch(() => {});
  }

  function engineTick() {
    if (!camp || !E.on) return;
    const now = Date.now(); const cfg = camp.cfg;
    // agentes virtuales
    agents.forEach((a) => {
      if (!a.bot || E.busyAgents.has(a.id)) return;
      if (a.state === 'llamada' && now >= (a.talkEnd || 0)) botFinish(a);
      else if (a.state === 'tipificando' && now >= (a.wrapEnd || 0)) AG.doc(a.id).update({ state: 'libre', since: now, contactId: null }).catch(() => {});
    });
    // llamadas en curso
    E.calls.slice().forEach((call) => {
      const c = contactById(call.contactId);
      const drop = () => { const i = E.calls.indexOf(call); if (i >= 0) E.calls.splice(i, 1); };
      if (call.phase === 'ringing' && now >= call.end) {
        if (call.outcome === 'human') { E.pend.stats.human++; call.phase = 'waiting'; call.end = now + 2000; }
        else if (call.outcome === 'machine') { E.pend.stats.machine++; elog((c ? c.name : 'Cliente') + ': contestadora detectada (AMD), se cuelga'); finishNoContact(call, 'Contestadora (AMD)'); drop(); return; }
        else { E.pend.stats.noanswer++; finishNoContact(call, 'No contestó'); drop(); return; }
      }
      if (call.phase === 'waiting') {
        const fa = freeAgents(now)[0];
        if (fa) {
          call.phase = 'assigning'; E.busyAgents.add(fa.id);
          assign(call, fa).then((ok) => {
            E.busyAgents.delete(fa.id);
            if (ok) drop(); else call.phase = 'waiting';
          });
        } else if (now >= call.end) {
          E.pend.stats.abandoned++; pendBucket('ab');
          elog((c ? c.name : 'Cliente') + ' contestó y no había agente libre: abandono', 'warn');
          finishNoContact(call, 'Abandono (sin agente)'); drop();
        }
      }
    });
    // cuántas llamadas lanzar
    const free = freeAgents(now).length;
    const soon = agents.filter((a) => isOnline(a, now) && ((a.state === 'tipificando' && (a.bot ? (a.wrapEnd || 0) - now < 6000 : true)) || (a.bot && a.state === 'llamada' && (a.talkEnd || 0) - now < 6000))).length;
    let want;
    if (cfg.mode === 'progresivo') { E.ratio = 1; want = free - E.calls.length; }
    else {
      E.adj = Math.min(1.6, Math.max(0.4, E.adj + (cfg.target - recentAband()) * 0.004));
      E.ratio = Math.min(cfg.maxRatio, Math.max(1, (1 / contactRate()) * E.adj * 0.85));
      want = Math.round((free + soon * 0.6) * E.ratio) - E.calls.length;
    }
    if (cfg.running && want > 0) {
      const inCall = new Set(E.calls.map((c) => c.contactId).concat(agents.map((a) => a.contactId).filter(Boolean)));
      const list = contacts
        .filter((c) => (c.status === 'pendiente' || c.status === 'rellamar') && (c.nextAt || 0) <= now && !inCall.has(c.id))
        .sort((a, b) => (b.status === 'rellamar') - (a.status === 'rellamar') || (a.attempts || 0) - (b.attempts || 0) || (b.daysLate || 0) - (a.daysLate || 0))
        .slice(0, Math.min(want, 4));
      list.forEach(dial);
      if (list.length) elog('Marcando ' + list.length + ' número' + (list.length > 1 ? 's' : '') + ' (' + free + ' libre' + (free === 1 ? '' : 's') + ', ratio ' + E.ratio.toFixed(1) + ')');
    }
    flush(false);
  }

  // ---------- vista del supervisor ----------
  async function syncBots(n) {
    const now = Date.now(); const b = db.batch(); let ops = 0;
    for (let i = 0; i < BOT_NAMES.length; i++) {
      const id = 'bot_' + i; const ex = agents.find((a) => a.id === id);
      if (i < n && !ex) { b.set(AG.doc(id), { name: BOT_NAMES[i] + ' (virtual)', role: 'agente', bot: true, state: 'libre', since: now, contactId: null, calls: 0, talk: 0, promises: 0, promAmt: 0 }); ops++; }
      if (i >= n && ex) { b.delete(AG.doc(id)); if (ex.contactId) b.update(CT.doc(ex.contactId), { status: 'pendiente' }); ops++; }
    }
    if (ops) await b.commit();
  }
  function setCfg(k, v) { act(CAMP.update({ ['cfg.' + k]: v })); }

  function renderControls() {
    if (!camp) return;
    const cfg = camp.cfg || DEFAULT_CAMP().cfg;
    $('modePred').setAttribute('aria-checked', cfg.mode === 'predictivo');
    $('modeProg').setAttribute('aria-checked', cfg.mode === 'progresivo');
    $('modeHelp').textContent = cfg.mode === 'predictivo'
      ? 'Lanza varias llamadas por agente según la tasa de contacto y se frena si el abandono se acerca al límite.'
      : 'Marca una llamada solo cuando un agente queda libre. Cero abandono, menos productividad.';
    $('abVal').textContent = Number(cfg.target).toFixed(1) + '%';
    $('abDown').disabled = cfg.mode !== 'predictivo'; $('abUp').disabled = cfg.mode !== 'predictivo';
    if (document.activeElement !== $('maxRatio')) $('maxRatio').value = String(cfg.maxRatio);
    if (document.activeElement !== $('bots')) $('bots').value = String(cfg.bots || 0);
    $('btnRun').textContent = cfg.running ? 'Pausar campaña' : 'Reanudar campaña';
    $('btnRun').className = 'btn ' + (cfg.running ? '' : 'primary');
  }
  function renderEngineBox() {
    const active = engineActive();
    const live = active && camp.cfg.running;
    $('liveDot').classList.toggle('on', live);
    $('liveText').textContent = !active ? 'Marcador detenido' : camp.cfg.running ? 'Marcador activo' : 'Campaña en pausa';
    if (E.on) { $('engText').textContent = 'Activo en esta pestaña'; $('engChip').className = 'chip ok'; $('btnEngine').textContent = 'Detener motor'; $('btnEngine').className = 'btn'; $('btnEngine').disabled = false; $('engHelp').textContent = 'No cierres esta pestaña: si se cierra, el marcador se detiene y otro supervisor puede tomarlo.'; }
    else if (active) { $('engText').textContent = 'Activo · ' + camp.engine.name; $('engChip').className = 'chip ok'; $('btnEngine').textContent = 'Corre en otra pestaña'; $('btnEngine').disabled = true; $('engHelp').textContent = 'El motor corre en la pestaña de ' + camp.engine.name + '.'; }
    else { $('engText').textContent = 'Detenido'; $('engChip').className = 'chip warn'; $('btnEngine').textContent = 'Iniciar motor en esta pestaña'; $('btnEngine').className = 'btn primary'; $('btnEngine').disabled = false; $('engHelp').textContent = 'El motor corre en la pestaña de un supervisor. Mientras esté abierta, marca y reparte llamadas a todos los agentes.'; }
  }
  function renderSupervisor() {
    if (!camp) return;
    const now = Date.now(); const cfg = camp.cfg;
    const online = agents.filter((a) => a.state !== 'pausa' && isOnline(a, now));
    const cnt = (st) => online.filter((a) => a.state === st).length;
    $('kAgents').innerHTML = online.length + '<small> / ' + agents.length + '</small>';
    $('kAgentsSub').textContent = cnt('llamada') + ' en llamada · ' + cnt('libre') + ' libres · ' + cnt('tipificando') + ' tipificando';
    $('kRatio').textContent = (E.on ? E.ratio : camp.ratio || 1).toFixed(1);
    const conn = totalStat('connected'), ab = totalStat('abandoned'), tot = conn + ab;
    const abPct = tot ? (ab / tot) * 100 : 0;
    $('kAband').textContent = abPct.toFixed(1) + '%';
    const sub = $('kAbandSub'); sub.textContent = (abPct <= cfg.target ? 'Bajo' : 'Sobre') + ' el límite de ' + Number(cfg.target).toFixed(1) + '%'; sub.className = 's ' + (abPct <= cfg.target ? 'good' : 'bad');
    $('kContacts').textContent = totalStat('human');
    $('kContactsSub').textContent = totalStat('dialed') + ' marcadas · ' + totalStat('machine') + ' contestadoras · tasa ' + Math.round(contactRate() * 100) + '%';
    const touched = contacts.filter((c) => (c.attempts || 0) > 0 || c.status !== 'pendiente').length;
    const pct = contacts.length ? Math.round((touched / contacts.length) * 100) : 0;
    $('kList').textContent = pct + '%'; $('kListBar').style.width = pct + '%';
    const proms = contacts.filter((c) => c.status === 'promesa');
    $('kPromises').textContent = proms.length;
    $('kPromisesSub').textContent = money(proms.reduce((s, c) => s + ((c.promise && c.promise.amount) || 0), 0)) + ' comprometidos';
    $('listInfo').textContent = contacts.length ? contacts.length + ' clientes · ' + contacts.filter((c) => c.status === 'pendiente' || c.status === 'rellamar').length + ' por marcar' : 'La lista está vacía. Carga clientes para empezar.';

    const b = bucketsMerged(); const k = Math.floor(now / 60000); const bars = [];
    for (let i = k - 19; i <= k; i++) { const x = b[i] || { conn: 0, ab: 0 }; const n = x.conn + x.ab; bars.push(n ? (x.ab / n) * 100 : 0); }
    const H = 170, MAX = 10;
    let html = '<span class="ax" style="top:0">10%</span><span class="ax" style="bottom:2px">0%</span>';
    html += '<div class="lim" style="bottom:' + Math.round((Math.min(cfg.target, MAX) / MAX) * H) + 'px"></div>';
    if (!tot) html += '<div class="empty">Se llena conforme avanza la campaña</div>';
    html += bars.map((v) => '<div class="b' + (v > cfg.target ? ' over' : '') + '" title="' + v.toFixed(1) + '%" style="height:' + Math.max(2, Math.round((Math.min(v, MAX) / MAX) * H)) + 'px"></div>').join('');
    $('chart').innerHTML = html;

    const order = { llamada: 0, tipificando: 1, libre: 2, pausa: 3 };
    $('agentRows').innerHTML = agents.slice().sort((x, y) => (order[x.state] - order[y.state]) || x.name.localeCompare(y.name)).map((a) => {
      const c = a.contactId ? contactById(a.contactId) : null;
      const off = !isOnline(a, now);
      const st = off ? 'pausa' : a.state;
      const label = off ? 'Desconectado' : { libre: 'Libre', llamada: 'En llamada', tipificando: 'Tipificando', pausa: 'Pausa' }[a.state];
      return '<tr><td style="font-weight:500">' + esc(a.name) + (a.id === uid ? ' <span class="chip ok">tú</span>' : '') + (a.role === 'supervisor' ? ' <span class="chip">sup.</span>' : '') + '</td>' +
        '<td><span class="st ' + st + '"><span class="d"></span>' + label + '</span></td>' +
        '<td class="num">' + mmss((now - (a.since || now)) / 1000) + '</td>' +
        '<td>' + (c ? esc(c.name) : '<span class="sub">—</span>') + '</td>' +
        '<td class="num">' + (a.calls || 0) + '</td><td class="num">' + (a.calls ? mmss(a.talk / a.calls) : '—') + '</td></tr>';
    }).join('');
    const log = E.on ? E.log : (camp.log || []);
    $('log').innerHTML = log.slice(0, 40).map((l) => '<li><span class="t">' + hhmmss(l.t) + '</span><span class="x ' + l.kind + '">' + esc(l.text) + '</span></li>').join('') || '<li class="sub">Sin actividad todavía.</li>';
  }

  $('btnEngine').addEventListener('click', () => { if (E.on) stopEngine(); else startEngine(); });
  document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => setCfg('mode', b.dataset.mode)));
  $('abDown').addEventListener('click', () => setCfg('target', Math.max(0.5, camp.cfg.target - 0.5)));
  $('abUp').addEventListener('click', () => setCfg('target', Math.min(8, camp.cfg.target + 0.5)));
  $('maxRatio').addEventListener('change', (e) => setCfg('maxRatio', +e.target.value));
  $('bots').addEventListener('change', (e) => { const n = +e.target.value; setCfg('bots', n); syncBots(n).catch((ex) => toast(fbError(ex))); });
  $('btnRun').addEventListener('click', () => {
    const running = !camp.cfg.running; setCfg('running', running);
    if (E.on) elog(running ? 'Campaña reanudada' : 'Campaña pausada por ' + me.name, running ? 'ok' : 'warn');
  });

  // Carga de clientes
  function sampleContacts() {
    let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const first = ['María Fernanda', 'José Luis', 'Guadalupe', 'Juan Carlos', 'Ana Sofía', 'Miguel Ángel', 'Rosa Elena', 'Francisco', 'Daniela', 'Alejandro', 'Verónica', 'Ricardo', 'Patricia', 'Eduardo', 'Mariana', 'Fernando', 'Leticia', 'Arturo', 'Claudia', 'Roberto', 'Gabriela', 'Héctor', 'Adriana', 'Sergio', 'Lucía', 'Raúl', 'Karla', 'Javier', 'Norma', 'Óscar'];
    const last = ['López', 'Hernández', 'García', 'Martínez', 'González', 'Rodríguez', 'Pérez', 'Sánchez', 'Ramírez', 'Cruz', 'Flores', 'Gómez', 'Morales', 'Vázquez', 'Reyes', 'Jiménez', 'Torres', 'Díaz', 'Gutiérrez', 'Ruiz', 'Mendoza', 'Aguilar', 'Ortiz', 'Castillo', 'Romero'];
    const ladas = ['55', '33', '81', '222', '229', '442', '999'];
    const segs = ['Preferente', 'Clásico', 'Nuevo'];
    const out = [];
    for (let i = 0; i < 80; i++) {
      const name = first[Math.floor(rnd() * first.length)] + ' ' + last[Math.floor(rnd() * last.length)] + ' ' + last[Math.floor(rnd() * last.length)];
      const lada = ladas[Math.floor(rnd() * ladas.length)];
      const digits = String(Math.floor(rnd() * 1e10)).padStart(10, '0').slice(lada.length);
      const balance = Math.round((800 + rnd() * 14000) / 10) * 10;
      out.push({
        id: 'CL-' + String(48100 + i * 7).padStart(7, '0'),
        data: { folio: 'CL-' + String(48100 + i * 7).padStart(7, '0'), name, phone: '+52 ' + lada + ' ' + digits.slice(0, 4) + ' ' + digits.slice(4), balance, minPay: Math.round(balance * 0.15 / 10) * 10, daysLate: 3 + Math.floor(rnd() * 45), segment: segs[Math.floor(rnd() * segs.length)] }
      });
    }
    return out;
  }
  async function writeContacts(rows, source) {
    const now = Date.now();
    for (let i = 0; i < rows.length; i += 400) {
      const b = db.batch();
      rows.slice(i, i + 400).forEach((r) => {
        const ref = r.id ? CT.doc(r.id) : CT.doc();
        b.set(ref, Object.assign({ folio: ref.id }, r.data, { status: 'pendiente', attempts: 0, nextAt: 0, promise: null, history: [{ t: now, title: source, by: me.name }] }));
      });
      await b.commit();
    }
  }
  $('btnSeed').addEventListener('click', async () => {
    $('btnSeed').disabled = true;
    try { await writeContacts(sampleContacts(), 'Cargado en la lista de ejemplo'); toast('80 clientes de ejemplo cargados.'); }
    catch (ex) { toast(fbError(ex)); } finally { $('btnSeed').disabled = false; }
  });
  function parseCsv(text) {
    const rows = []; let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',' || ch === ';') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
      else cur += ch;
    }
    row.push(cur); if (row.some((x) => x.trim())) rows.push(row);
    return rows;
  }
  $('csvFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const rows = parseCsv(await f.text());
      const norm = (s) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_');
      const head = rows.shift().map(norm);
      const col = (names) => head.findIndex((h) => names.includes(h));
      const iN = col(['nombre', 'name', 'cliente']), iT = col(['telefono', 'phone', 'tel', 'celular']);
      if (iN < 0 || iT < 0) { toast('El CSV necesita al menos las columnas “nombre” y “telefono”.'); return; }
      const iS = col(['saldo', 'balance']), iM = col(['pago_minimo', 'minimo', 'pago_min']), iD = col(['dias_atraso', 'atraso', 'dias']);
      const num = (r, i) => (i >= 0 ? parseFloat(String(r[i]).replace(/[^0-9.\-]/g, '')) || 0 : 0);
      const data = rows.filter((r) => (r[iN] || '').trim() && (r[iT] || '').trim()).map((r) => ({ data: { name: r[iN].trim(), phone: r[iT].trim(), balance: num(r, iS), minPay: num(r, iM), daysLate: Math.round(num(r, iD)), segment: '' } }));
      await writeContacts(data, 'Importado desde ' + f.name);
      toast(data.length + ' clientes importados.');
    } catch (ex) { toast(fbError(ex)); }
    e.target.value = '';
  });
  $('btnResetCamp').addEventListener('click', () => { $('resetConfirm').hidden = false; });
  $('resetNo').addEventListener('click', () => { $('resetConfirm').hidden = true; });
  $('resetYes').addEventListener('click', async () => {
    $('resetConfirm').hidden = true;
    try {
      E.calls = []; if (E.on) { E.pend = freshPend(); E.log = []; }
      for (let i = 0; i < contacts.length; i += 400) {
        const b = db.batch();
        contacts.slice(i, i + 400).forEach((c) => b.update(CT.doc(c.id), { status: 'pendiente', attempts: 0, nextAt: 0, promise: null }));
        await b.commit();
      }
      await CAMP.update({ stats: DEFAULT_CAMP().stats, buckets: {}, log: [], ratio: 1 });
      toast('Campaña reiniciada.');
    } catch (ex) { toast(fbError(ex)); }
  });

  // ---------- vista de clientes ----------
  let selected = null;
  function renderClients() {
    const q = $('q').value.trim().toLowerCase(); const f = $('fStatus').value;
    const rows = contacts.filter((c) => (!f || c.status === f) && (!q || (c.name + ' ' + c.phone + ' ' + (c.folio || c.id)).toLowerCase().includes(q)))
      .sort((a, b) => String(a.folio || a.id).localeCompare(String(b.folio || b.id)));
    $('cliCount').textContent = contacts.length ? rows.length + ' de ' + contacts.length + ' clientes' : 'Todavía no hay clientes. Un supervisor puede cargarlos desde la pestaña Supervisor.';
    $('cliRows').innerHTML = rows.map((c) => {
      const s = STATUS[c.status] || STATUS.pendiente;
      return '<tr class="click' + (c.id === selected ? ' sel' : '') + '" data-id="' + esc(c.id) + '" tabindex="0"><td class="num">' + esc(c.folio || c.id) + '</td><td style="font-weight:500">' + esc(c.name) + '</td><td class="num">' + esc(c.phone) + '</td><td class="num">' + money(c.balance) + '</td><td class="num">' + (c.daysLate || 0) + ' d</td><td class="num">' + (c.attempts || 0) + '/' + MAX_ATTEMPTS + '</td><td><span class="chip ' + s.cls + '">' + s.label + '</span></td></tr>';
    }).join('');
    renderDetail();
  }
  function renderDetail() {
    const c = selected && contactById(selected); if (!c) return;
    const s = STATUS[c.status] || STATUS.pendiente;
    $('cliDetail').innerHTML = '<span class="eyebrow">Ficha del cliente</span>' +
      '<div class="cust-head"><div class="avatar">' + esc(initials(c.name)) + '</div><div style="min-width:0"><h2>' + esc(c.name) + '</h2><div class="sub">' + esc(c.folio || c.id) + ' · ' + esc(c.phone) + '</div></div></div>' +
      '<div><span class="chip ' + s.cls + '">' + s.label + '</span></div>' +
      '<div class="facts"><div><div class="k">Saldo</div><div class="v mono">' + money(c.balance) + '</div></div><div><div class="k">Pago mínimo</div><div class="v mono">' + money(c.minPay) + '</div></div>' +
      (c.promise ? '<div><div class="k">Promesa</div><div class="v mono">' + money(c.promise.amount) + '</div></div>' : '') + '</div>' +
      '<span class="eyebrow">Historial</span><ul class="timeline">' + historyHtml(c, 15) + '</ul>';
  }
  function selectRow(tr) { if (!tr) return; selected = tr.dataset.id; renderClients(); }
  $('cliRows').addEventListener('click', (e) => selectRow(e.target.closest('tr')));
  $('cliRows').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectRow(e.target.closest('tr')); } });
  $('q').addEventListener('input', renderClients); $('fStatus').addEventListener('change', renderClients);

  // ---------- navegación ----------
  let currentView = 'agente', lastClients = 0;
  function show(view) {
    if (view === 'supervisor' && !isSup()) view = 'agente';
    if (!['agente', 'supervisor', 'clientes'].includes(view)) view = 'agente';
    currentView = view;
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.view === view));
    ['agente', 'supervisor', 'clientes'].forEach((v) => { $('view-' + v).hidden = v !== view; });
    if (view === 'agente') $('tabDot').hidden = true;
    try { localStorage.setItem('c360_view', view); } catch (e) {}
    renderAll(true);
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
  function renderAll(force) {
    if (!me) return;
    renderEngineBox();
    if (currentView === 'agente') renderAgent();
    if (currentView === 'supervisor') renderSupervisor();
    if (currentView === 'clientes' && (force === true || Date.now() - lastClients > 1500)) { lastClients = Date.now(); renderClients(); }
  }
})();
