(() => {
  'use strict';
  const { api, post, el, portrait, copy } = Election;
  const $ = selector => document.querySelector(selector);
  let current = null;
  let online = false;
  let dirty = false;
  let actionBusy = false;
  let settingsSaving = false;
  let candidateSaving = false;
  let refreshPromise = null;
  let candidateSignature = '';
  let eventSignature = '';
  let settingsSignature = '';
  let toastTimer;
  let photoPromise = Promise.resolve('');
  let photoVersion = 0;
  let originalPhoto = '';

  const settingNames = ['schoolName','electionName','panelATitle','panelARunnerup','panelBTitle','panelBRunnerup'];
  const settingKeys = ['school_name','election_name','panel_a_title','panel_a_runnerup','panel_b_title','panel_b_runnerup'];
  const settingsBody = () => Object.fromEntries(settingNames.map(name => [name, $('#settings-form').elements[name].value.trim()]));
  function toast(message) {
    $('#toast').textContent = message; $('#toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4000);
  }
  function formError(selector, message = '') { $(selector).textContent = message; $(selector).hidden = !message; }
  function address(path) {
    const host = current.lanIP || location.hostname;
    return `${location.protocol}//${host}${location.port ? `:${location.port}` : ''}${path}`;
  }

  function render() {
    if (!current) return;
    const s = current.settings;
    const setup = s.state === 'setup';
    const published = s.state === 'closed' && Boolean(s.results_revealed);
    const state = published ? 'published' : s.state;
    const locked = !setup || !online || actionBusy;
    const states = {
      setup: ['Setup', 'Save the school details and add at least two candidates to each panel.'],
      open: ['Voting open', 'Voting machines are accepting votes. Pause to take a break, or close to finish.'],
      paused: ['Voting paused', 'All voting machines are paused. Resume when you are ready.'],
      closed: ['Voting closed', 'No more votes can be cast. Publish the results when you are ready.'],
      published: ['Results published', 'Final results are visible on the results page. Voting remains closed.']
    };
    $('#control').dataset.state = state;
    $('#state-title').textContent = states[state][0];
    const counts = ['a','b'].map(panel => current.candidates.filter(c => c.panel === panel).length);
    const ready = counts.every(count => count >= 2);
    $('#state-description').textContent = setup && dirty ? 'You have unsaved setup changes. Save them before opening voting.' :
      setup && ready ? 'Both panels are ready. Check the voting machines, then open voting.' : states[state][1];
    $('#header-school').textContent = [s.school_name, s.election_name].filter(Boolean).join(' · ');
    document.title = `Election control — ${s.school_name}`;
    for (const panel of ['a','b']) {
      const title = s[`panel_${panel}_title`];
      $(`#total-${panel}`).textContent = current.voteTotals[panel].toLocaleString();
      $(`#total-${panel}-title`).textContent = title;
      $(`#machine-${panel}-title`).textContent = title;
      const count = current.activeStations[panel];
      $(`#online-${panel}`).textContent = `${count} ${count === 1 ? 'machine' : 'machines'} online`;
      $(`#panel-${panel}-heading`).textContent = title;
      $(`#secondary-${panel}`).textContent = `Second place: ${s[`panel_${panel}_runnerup`]}`;
      const url = address(`/vote/${panel}`);
      $(`#url-${panel}`).textContent = url; $(`#url-${panel}`).href = url;
    }
    $('#url-results').href = address('/results'); $('#url-results').textContent = address('/results');
    $('#open-btn').hidden = !(setup || s.state === 'paused');
    $('#open-btn').textContent = s.state === 'paused' ? 'Resume voting' : 'Open voting';
    $('#open-btn').disabled = !online || actionBusy || (setup && (!ready || dirty));
    $('#pause-btn').hidden = s.state !== 'open';
    $('#close-btn').hidden = !['open','paused'].includes(s.state);
    $('#publish-btn').hidden = s.state !== 'closed' || published;
    $('#unpublish-btn').hidden = !published;
    for (const id of ['pause-btn','close-btn','publish-btn','unpublish-btn']) $(`#${id}`).disabled = !online || actionBusy;
    $('#reset-btn').disabled = !online || actionBusy || s.state === 'open';
    $('#reset-btn').title = s.state === 'open' ? 'Pause or close voting before resetting votes.' : '';
    $('#candidate-lock').textContent = setup ? `${current.candidates.length} candidates · two separate ballots` : 'Ballot setup is locked while this election is in progress.';
    document.querySelectorAll('[data-add]').forEach(button => { button.disabled = locked; });
    $('#settings-fields').disabled = locked || settingsSaving;
    $('#setup-status').textContent = !setup ? 'Locked until votes are reset' : dirty ? 'Unsaved changes' : 'Names used on the ballots and results';
    const signature = JSON.stringify(settingKeys.map(key => s[key]));
    if (!dirty && !settingsSaving && signature !== settingsSignature) {
      settingNames.forEach((name,index) => { $('#settings-form').elements[name].value = s[settingKeys[index]]; });
      settingsSignature = signature;
    }
    const candidatesKey = JSON.stringify([current.candidates, locked]);
    if (candidatesKey !== candidateSignature) {
      candidateSignature = candidatesKey;
      ['a','b'].forEach(panel => renderCandidates(panel, locked));
    }
    const eventsKey = JSON.stringify(current.events);
    if (eventsKey !== eventSignature) { eventSignature = eventsKey; renderEvents(); }
    $('#admin-main').setAttribute('aria-busy', 'false');
  }

  function renderCandidates(panel, locked) {
    const candidates = current.candidates.filter(c => c.panel === panel);
    const list = $(`#candidate-list-${panel}`);
    list.replaceChildren();
    if (!candidates.length) { list.append(el('p','empty','No candidates yet. Add a candidate to this panel.')); return; }
    for (const candidate of candidates) {
      const row = el('div','candidate-row');
      const info = el('div','candidate-info');
      info.append(el('strong','',candidate.name));
      if (candidate.detail) info.append(el('span','',candidate.detail));
      const actions = el('div','row-actions');
      const edit = el('button','button button-small button-text','Edit');
      edit.type = 'button'; edit.disabled = locked; edit.setAttribute('aria-label',`Edit ${candidate.name}`);
      edit.addEventListener('click', () => openCandidate(panel, candidate));
      const remove = el('button','button button-small button-text error','Delete');
      remove.type = 'button'; remove.disabled = locked; remove.setAttribute('aria-label',`Delete ${candidate.name}`);
      remove.addEventListener('click', () => deleteCandidate(candidate));
      actions.append(edit,remove); row.append(portrait(candidate,'candidate-thumb'),info,actions); list.append(row);
    }
  }
  function renderEvents() {
    const list = $('#event-list'); list.replaceChildren();
    for (const event of current.events) {
      const row = el('div','event'); const time = el('time');
      const date = new Date(event.created_at); time.dateTime = event.created_at;
      time.textContent = `${date.toLocaleDateString(undefined,{month:'short',day:'numeric'})} ${date.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'})}`;
      row.append(time,el('span','',event.detail)); list.append(row);
    }
  }
  async function refresh(force = false) {
    if (refreshPromise) {
      await refreshPromise;
      if (!force) return;
    }
    refreshPromise = (async () => {
      try {
        current = await api('/api/admin/state'); online = true;
        if ($('#connection').textContent !== 'Server connected') $('#connection').textContent = 'Server connected';
        $('#connection').classList.remove('offline');
        $('#connection-error').hidden = true; render();
      } catch (error) {
        online = false;
        if ($('#connection').textContent !== 'Connection lost') $('#connection').textContent = 'Connection lost';
        $('#connection').classList.add('offline');
        $('#connection-error').textContent = error.message; $('#connection-error').hidden = false; render();
      } finally { refreshPromise = null; }
    })();
    return refreshPromise;
  }
  async function runAction(url, body, message) {
    if (actionBusy) return;
    actionBusy = true; render();
    try { await post(url,body); toast(message); }
    catch (error) { toast(error.message); }
    finally { await refresh(true); actionBusy = false; render(); }
  }

  const confirmDialog = $('#confirm-dialog');
  let requiredConfirmation = '';
  function confirmAction({ title, message, confirmText, requiredText = '', danger = false }) {
    return new Promise(resolve => {
      requiredConfirmation = requiredText;
      $('#confirm-title').textContent = title; $('#confirm-message').textContent = message;
      $('#confirm-input-wrap').hidden = !requiredText; $('#confirm-input').value = '';
      $('#confirm-input-label').textContent = `Type ${requiredText} to continue`;
      const button = $('#confirm-action'); button.textContent = confirmText;
      button.className = `button ${danger ? 'button-danger' : 'button-primary'}`;
      button.disabled = Boolean(requiredText); confirmDialog.returnValue = '';
      confirmDialog.addEventListener('close', () => resolve(confirmDialog.returnValue === 'confirmed'), { once: true });
      confirmDialog.showModal();
      (requiredText ? $('#confirm-input') : $('#confirm-cancel')).focus();
    });
  }
  $('#confirm-input').addEventListener('input', () => { $('#confirm-action').disabled = Boolean(requiredConfirmation) && $('#confirm-input').value !== requiredConfirmation; });
  $('#confirm-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!requiredConfirmation || $('#confirm-input').value === requiredConfirmation) confirmDialog.close('confirmed');
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.close === 'candidate-dialog' && candidateSaving) return;
    $(`#${button.dataset.close}`).close('cancelled');
  }));
  $('#candidate-dialog').addEventListener('cancel', event => { if (candidateSaving) event.preventDefault(); });

  $('#settings-form').addEventListener('input', () => {
    if (!current) return;
    const body = settingsBody(); dirty = settingNames.some((name,index) => body[name] !== current.settings[settingKeys[index]]);
    formError('#settings-error'); render();
  });
  $('#settings-form').addEventListener('submit', async event => {
    event.preventDefault(); if (settingsSaving) return;
    settingsSaving = true; render(); formError('#settings-error');
    try {
      await post('/api/admin/settings',settingsBody()); dirty = false; settingsSignature = ''; toast('Election setup saved.');
    } catch (error) { formError('#settings-error',error.message); }
    finally { await refresh(true); settingsSaving = false; render(); }
  });

  async function resizePhoto(file) {
    if (!file) return '';
    if (file.size > 80 * 1024 * 1024) throw new Error('Choose a photograph under 80 MB.');
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) throw new Error('Use a JPEG, PNG or WebP photo. Export HEIC photos as JPEG first.');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url;
      await image.decode().catch(() => { throw new Error('This photo could not be opened. Try exporting it as JPEG.'); });
      if (image.naturalWidth * image.naturalHeight > 160000000) throw new Error('This image is too large to process. Export a smaller JPEG.');
      const scale = Math.min(1,1400 / image.naturalWidth,1600 / image.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1,Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1,Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('The browser could not prepare this photo.');
      context.fillStyle = '#ffffff'; context.fillRect(0,0,canvas.width,canvas.height);
      context.drawImage(image,0,0,canvas.width,canvas.height);
      let quality = .88; let data = canvas.toDataURL('image/jpeg',quality);
      while (data.length > 4 * 1024 * 1024 && quality > .48) { quality -= .1; data = canvas.toDataURL('image/jpeg',quality); }
      return data;
    } finally { URL.revokeObjectURL(url); }
  }
  function preview(photo = '') { $('#photo-preview').replaceChildren(portrait({name: $('#candidate-name').value || 'Photo',photo})); }
  function openCandidate(panel, candidate = null) {
    if (current?.settings.state !== 'setup' || candidateSaving) return;
    $('#candidate-form').reset(); $('#candidate-id').value = candidate?.id || '';
    $('#candidate-name').value = candidate?.name || ''; $('#candidate-detail').value = candidate?.detail || '';
    $('#candidate-panel').value = panel; originalPhoto = candidate?.photo || '';
    $('#candidate-panel').options[0].textContent = `Panel A — ${current.settings.panel_a_title}`;
    $('#candidate-panel').options[1].textContent = `Panel B — ${current.settings.panel_b_title}`;
    $('#candidate-dialog-title').textContent = candidate ? 'Edit candidate' : 'Add candidate';
    $('#save-candidate').textContent = candidate ? 'Save candidate' : 'Add candidate';
    $('#remove-photo-wrap').hidden = !originalPhoto;
    photoVersion++; photoPromise = Promise.resolve(''); preview(originalPhoto); formError('#candidate-error');
    $('#candidate-dialog').showModal(); $('#candidate-name').focus();
  }
  document.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => openCandidate(button.dataset.add)));
  $('#candidate-photo').addEventListener('change', () => {
    const version = ++photoVersion; formError('#candidate-error');
    photoPromise = resizePhoto($('#candidate-photo').files[0]);
    photoPromise.then(photo => {
      if (version !== photoVersion) return;
      $('#remove-photo').checked = false; preview(photo || originalPhoto);
    }).catch(error => { if (version === photoVersion) { formError('#candidate-error',error.message); preview(originalPhoto); } });
  });
  $('#candidate-name').addEventListener('input', () => {
    const version = photoVersion;
    photoPromise.then(photo => { if (version === photoVersion) preview(photo || ($('#remove-photo').checked ? '' : originalPhoto)); }).catch(() => {});
  });
  $('#remove-photo').addEventListener('change', () => {
    if ($('#remove-photo').checked) { $('#candidate-photo').value = ''; photoVersion++; photoPromise = Promise.resolve(''); preview(); }
    else preview(originalPhoto);
  });
  $('#candidate-form').addEventListener('submit', async event => {
    event.preventDefault(); if (candidateSaving) return;
    candidateSaving = true; $('#save-candidate').disabled = true; $('#save-candidate').textContent = 'Saving…';
    $('#candidate-form').querySelectorAll('input,select,button').forEach(input => { input.disabled = true; });
    formError('#candidate-error');
    const id = $('#candidate-id').value;
    try {
      const photo = await photoPromise;
      await post(`/api/admin/candidate/${id ? 'update' : 'add'}`, {
        id, panel: $('#candidate-panel').value, name: $('#candidate-name').value, detail: $('#candidate-detail').value,
        photo, removePhoto: $('#remove-photo').checked
      });
      $('#candidate-dialog').close(); toast(id ? 'Candidate updated.' : 'Candidate added.');
    } catch (error) { formError('#candidate-error',error.message); }
    finally {
      candidateSaving = false;
      $('#candidate-form').querySelectorAll('input,select,button').forEach(input => { input.disabled = false; });
      $('#save-candidate').textContent = id ? 'Save candidate' : 'Add candidate'; await refresh(true);
    }
  });
  async function deleteCandidate(candidate) {
    if (await confirmAction({title:'Delete candidate',message:`Remove ${candidate.name} from this ballot?`,confirmText:'Delete candidate',danger:true})) {
      await runAction('/api/admin/candidate/delete',{id:candidate.id},'Candidate deleted.');
    }
  }
  $('#open-btn').addEventListener('click', async () => {
    if (dirty) { location.hash = 'setup'; toast('Save the setup changes first.'); return; }
    if (current.settings.state === 'setup' && !await confirmAction({title:'Open voting',message:'Both ballots will accept votes. School details and candidates will be locked until votes are reset.',confirmText:'Open voting'})) return;
    await runAction('/api/admin/state/change',{state:'open'},'Voting is open.');
  });
  $('#pause-btn').addEventListener('click', () => runAction('/api/admin/state/change',{state:'paused'},'Voting paused.'));
  $('#close-btn').addEventListener('click', async () => {
    if (await confirmAction({title:'Close voting',message:'Stop voting on every machine. Closing is final: reopening requires resetting every vote.',confirmText:'Close voting',danger:true})) {
      await runAction('/api/admin/state/change',{state:'closed'},'Voting closed. Results are still hidden.');
    }
  });
  $('#publish-btn').addEventListener('click', async () => {
    if (await confirmAction({title:'Publish results',message:'Make elected candidates, ties and final vote totals visible on the results page.',confirmText:'Publish results'})) {
      await runAction('/api/admin/results/reveal',{},'Results published.');
    }
  });
  $('#unpublish-btn').addEventListener('click', async () => {
    if (await confirmAction({title:'Unpublish results',message:'Hide the results page. Recorded votes are kept and voting stays closed.',confirmText:'Unpublish results'})) {
      await runAction('/api/admin/results/hide',{},'Results unpublished.');
    }
  });
  $('#reset-btn').addEventListener('click', async () => {
    if (await confirmAction({title:'Reset all votes',message:`Permanently delete all ${current.voteTotals.all} recorded votes and return to setup. Candidates, photos and role names are kept.`,confirmText:'Reset votes',requiredText:'RESET VOTES',danger:true})) {
      await runAction('/api/admin/reset',{confirm:'RESET VOTES'},'Votes reset. The election is back in setup.');
    }
  });
  document.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    toast(await copy($(`#${button.dataset.copy}`).textContent) ? 'Address copied.' : 'Select the address and copy it manually.');
  }));
  async function poll() { await refresh(); setTimeout(poll,3000); }
  poll();
})();
