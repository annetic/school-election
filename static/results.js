(() => {
  'use strict';
  const { api, el, portrait } = Election;
  const $ = selector => document.querySelector(selector);
  const text = (selector, value) => { const node = $(selector); if (node.textContent !== value) node.textContent = value; };
  let signature = '';
  function person(candidate) {
    const block = el('div','person');
    const info = el('div','person-info');
    info.append(el('p','person-name',candidate.name));
    if (candidate.detail) info.append(el('p','person-detail',candidate.detail));
    info.append(el('p','person-votes',`${candidate.votes.toLocaleString()} ${candidate.votes === 1 ? 'vote' : 'votes'}`));
    block.append(portrait(candidate,'person-photo'),info); return block;
  }
  function roleCard(title, candidates, tie, secondary, panel) {
    const card = el('section',`role-card ${secondary ? 'secondary-card' : 'primary-card'}`);
    card.append(el('h4','role-label',title));
    if (!candidates.length) {
      card.append(el('p','role-note',!panel.totalVotes ? 'No votes recorded. No candidate is elected.' :
        secondary && panel.assistantPending ? 'Second place is unresolved while first place is tied.' : 'No candidate available for this role.'));
    } else if (tie) {
      card.append(el('p','tie-heading',secondary ? 'Tie for second place — role unresolved' : 'Tie for first place — role unresolved'));
      const list = el('div','tie-list'); candidates.forEach(candidate => list.append(person(candidate))); card.append(list);
    } else card.append(person(candidates[0]));
    return card;
  }
  function ranking(data) {
    const table = el('table','ranking'); table.append(el('caption','','Complete ranking'));
    const head = el('thead'); const header = el('tr');
    ['Rank','Candidate','Votes'].forEach(label => { const cell = el('th','',label); cell.scope = 'col'; header.append(cell); });
    head.append(header); table.append(head); const body = el('tbody');
    const counts = new Map(); data.ranking.forEach(candidate => counts.set(candidate.votes,(counts.get(candidate.votes) || 0) + 1));
    let previous = null; let rank = 0;
    data.ranking.forEach((candidate,index) => {
      if (candidate.votes !== previous) { rank = index + 1; previous = candidate.votes; }
      const row = el('tr'); const rankCell = el('td','',rank);
      if (counts.get(candidate.votes) > 1) rankCell.append(el('span','rank-tie','Tied'));
      const name = el('td'); name.append(el('strong','',candidate.name));
      if (candidate.detail) name.append(el('span','detail',candidate.detail));
      row.append(rankCell,name,el('td','',candidate.votes.toLocaleString())); body.append(row);
    });
    table.append(body); return table;
  }
  function renderPanel(data) {
    const panel = el('section','result-panel');
    panel.setAttribute('aria-label',`Panel ${data.panel.toUpperCase()} results`);
    const heading = el('header','result-panel-header');
    heading.append(el('h3','',`Panel ${data.panel.toUpperCase()}`),el('p','',`${data.totalVotes.toLocaleString()} votes recorded`));
    panel.append(heading,roleCard(data.title,data.winner,data.winnerTie,false,data),
      roleCard(data.runnerUpTitle,data.assistant,data.assistantTie,true,data),ranking(data));
    return panel;
  }
  async function refresh() {
    try {
      const data = await api('/api/public/results');
      document.title = `Election results — ${data.schoolName}`;
      text('#school-name',data.schoolName); text('#election-name',data.electionName);
      $('#election-name').hidden = !data.electionName;
      if (!data.published) {
        $('#results-grid').hidden = true; $('#results-grid').replaceChildren(); signature = '';
        $('#results-status').hidden = false;
        text('#results-heading','Election results');
        text('#status-title','Results not published');
        text('#status-copy',data.state === 'closed' ? 'Voting is closed. Results will appear here when they are published.' : 'Results will be available after voting closes and they are published.');
        return;
      }
      text('#results-heading','Final results'); $('#results-status').hidden = true; $('#results-grid').hidden = false;
      const key = JSON.stringify(data);
      if (key !== signature) { signature = key; $('#results-grid').replaceChildren(renderPanel(data.panelA),renderPanel(data.panelB)); }
    } catch (_) {
      $('#results-grid').hidden = true; $('#results-grid').replaceChildren(); signature = '';
      $('#results-status').hidden = false; text('#status-title','Server unavailable');
      text('#status-copy','Check the connection to the election server. This page will reconnect automatically.');
    }
  }
  async function poll() { await refresh(); setTimeout(poll,2500); }
  poll();
})();
