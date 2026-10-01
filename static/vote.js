(() => {
  'use strict';
  const { api, post, el, portrait, makeId, storage } = Election;
  const $ = selector => document.querySelector(selector);
  const panel = location.pathname.split('/').filter(Boolean).pop();
  if (!['a','b'].includes(panel)) { location.replace('/vote'); return; }
  const stationKey = `election-station-${panel}`;
  const pendingKey = `election-pending-${panel}`;
  const stationId = storage.get(stationKey) || makeId();
  storage.set(stationKey,stationId);
  let pending = null;
  try {
    const saved = JSON.parse(storage.get(pendingKey));
    if (saved?.panel === panel && ['voteId','candidateId','electionId','stationId'].every(key => typeof saved[key] === 'string' && saved[key])) pending = saved;
  } catch (_) { storage.remove(pendingKey); }
  let mode = pending ? 'unconfirmed' : 'ready';
  let config = null;
  let online = false;
  let submitting = false;
  let candidateSignature = '';
  let votedUntil = 0;
  let successTimer;
  let rejectedMessage = '';
  const sound = new Audio(); sound.preload = 'auto';
  let soundAvailable = false;

  function showStatus(kind, title, detail = '', retry = false) {
    $('#ballot').hidden = true; $('#status-screen').hidden = false;
    $('#status-screen').className = `status-screen status-${kind}`;
    if ($('#status-title').textContent !== title) $('#status-title').textContent = title;
    if ($('#status-detail').textContent !== detail) $('#status-detail').textContent = detail;
    $('#status-detail').hidden = !detail; $('#retry-vote').hidden = !retry;
  }
  function layout() {
    if ($('#ballot').hidden) return;
    const count = config.panel.candidates.length;
    const width = window.innerWidth;
    const maxColumns = width < 540 ? 1 : width < 880 ? 2 : width < 1150 ? 3 : 4;
    const preferred = count <= 4 ? count : count <= 6 ? 3 : 4;
    const columns = Math.max(1,Math.min(preferred,maxColumns));
    const grid = $('#candidate-grid');
    grid.style.setProperty('--columns',columns);
    grid.style.maxWidth = count <= 2 ? '920px' : count === 3 ? '1240px' : '1480px';
    grid.style.removeProperty('--meta-height');
    const metaHeight = Math.max(...Array.from(grid.querySelectorAll('.candidate-meta'),item => item.offsetHeight));
    grid.style.setProperty('--meta-height',`${metaHeight}px`);
    const gap = parseFloat(getComputedStyle(grid).gap);
    const rows = Math.ceil(count / columns);
    const bottomPadding = parseFloat(getComputedStyle($('#ballot')).paddingBottom);
    const errorHeight = $('#vote-error').hidden ? 0 : $('#vote-error').offsetHeight + 12;
    const available = window.innerHeight - grid.getBoundingClientRect().top - bottomPadding - errorHeight;
    const photoHeight = Math.max(160,Math.min(500,(available - gap * (rows - 1)) / rows - metaHeight - 5));
    grid.style.setProperty('--photo-height',`${Math.floor(photoHeight)}px`);
  }
  function renderCandidates(candidates) {
    const signature = JSON.stringify(candidates);
    if (signature === candidateSignature) return;
    candidateSignature = signature;
    const grid = $('#candidate-grid'); grid.replaceChildren();
    for (const candidate of candidates) {
      const button = el('button','candidate'); button.type = 'button'; button.dataset.id = candidate.id;
      button.setAttribute('aria-label',`Vote for ${candidate.name}${candidate.detail ? `, ${candidate.detail}` : ''}`);
      const meta = el('span','candidate-meta'); meta.append(el('span','candidate-name',candidate.name));
      if (candidate.detail) meta.append(el('span','candidate-detail',candidate.detail));
      button.append(portrait(candidate,'candidate-photo'),meta);
      button.addEventListener('click', () => castVote(candidate.id)); grid.append(button);
    }
  }
  function render() {
    if (mode !== 'ready') return;
    if (!online || !config) { showStatus('error','SERVER UNAVAILABLE','Check the network connection. This screen will reconnect automatically.'); return; }
    if (config.state === 'paused') { showStatus('paused','VOTING PAUSED'); return; }
    if (config.state === 'closed') { showStatus('closed','VOTING CLOSED'); return; }
    if (config.state !== 'open') { showStatus('setup','VOTING NOT OPEN'); return; }
    if (!config.panel.candidates.length) { showStatus('error','BALLOT UNAVAILABLE','Ask the election administrator to check this panel.'); return; }
    const wasHidden = $('#ballot').hidden;
    const previousTitle = $('#role-title').textContent;
    $('#school-name').textContent = config.schoolName; $('#election-name').textContent = config.electionName;
    $('#election-name').hidden = !config.electionName; $('#role-title').textContent = config.panel.title;
    document.title = `${config.panel.title} — ${config.schoolName}`;
    const changed = candidateSignature !== JSON.stringify(config.panel.candidates);
    renderCandidates(config.panel.candidates);
    $('#candidate-grid').querySelectorAll('button').forEach(button => { button.disabled = false; });
    $('#vote-error').textContent = rejectedMessage; $('#vote-error').hidden = !rejectedMessage;
    $('#status-screen').hidden = true; $('#ballot').hidden = false;
    if (wasHidden || changed || previousTitle !== config.panel.title) layout();
  }
  function finishSuccess() {
    const remaining = votedUntil - performance.now();
    if (remaining > 0) { successTimer = setTimeout(finishSuccess,remaining); return; }
    mode = 'ready'; render();
  }
  function confirmed() {
    pending = null; storage.remove(pendingKey); mode = 'voted';
    showStatus('voted','VOTED');
    votedUntil = performance.now() + 5000; clearTimeout(successTimer); successTimer = setTimeout(finishSuccess,5000);
    if (soundAvailable) {
      try { sound.currentTime = 0; const playing = sound.play(); if (playing?.catch) playing.catch(() => {}); } catch (_) {}
    }
  }
  async function submitPending() {
    if (!pending || submitting) return;
    submitting = true; mode = 'submitting'; showStatus('submitting','SAVING VOTE');
    try {
      let reply;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { reply = await post('/api/vote',pending); break; }
        catch (error) { if (attempt === 1 || (error.status && error.status < 500)) throw error; }
      }
      if (!reply?.ok || reply.voteId !== pending.voteId) throw new Error('The server did not confirm this vote.');
      confirmed();
    } catch (error) {
      if (error.status && error.status < 500) {
        pending = null; storage.remove(pendingKey); mode = 'ready';
        rejectedMessage = `Vote not recorded. ${error.message}`; await refresh(); render();
      } else {
        mode = 'unconfirmed'; showStatus('unconfirmed','VOTE NOT CONFIRMED','Keep this screen open. Retry to confirm the same vote before the next voter.',true);
      }
    } finally { submitting = false; }
  }
  function castVote(candidateId) {
    if (mode !== 'ready' || pending || !online || config?.state !== 'open') return;
    rejectedMessage = '';
    pending = {voteId:makeId(),panel,candidateId,stationId,electionId:config.electionId};
    storage.set(pendingKey,JSON.stringify(pending));
    $('#candidate-grid').querySelectorAll('button').forEach(button => { button.disabled = true; });
    submitPending();
  }
  async function refresh() {
    try {
      config = await api(`/api/public/state?panel=${panel}`); online = true;
      soundAvailable = config.voteSoundAvailable;
      if (soundAvailable && !sound.getAttribute('src')) { sound.src = '/static/vote.mp3'; sound.load(); }
      render();
    } catch (_) { online = false; render(); }
  }
  async function poll() { await refresh(); setTimeout(poll,1500); }
  async function ping() {
    try { await post('/api/station/ping',{stationId,panel}); } catch (_) {}
    setTimeout(ping,5000);
  }
  $('#retry-vote').addEventListener('click',submitPending);
  window.addEventListener('resize',layout);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && mode === 'voted' && performance.now() >= votedUntil) finishSuccess(); });
  if (pending) showStatus('submitting','CONFIRMING VOTE');
  (async () => {
    await refresh();
    if (pending) submitPending();
    setTimeout(poll,1500);
  })();
  ping();
})();
