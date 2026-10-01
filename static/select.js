(() => {
  'use strict';
  async function refresh() {
    try {
      const data = await Election.api('/api/public/state');
      document.querySelector('#school-name').textContent = data.schoolName;
      document.querySelector('#election-name').textContent = data.electionName;
      document.querySelector('#title-a').textContent = data.panels.a.title;
      document.querySelector('#title-b').textContent = data.panels.b.title;
      document.querySelector('#select-error').hidden = true;
    } catch (error) { const box = document.querySelector('#select-error'); box.hidden = false; box.textContent = error.message; }
    setTimeout(refresh,5000);
  }
  document.querySelector('#admin-link').hidden = !['localhost','127.0.0.1','[::1]'].includes(location.hostname);
  refresh();
})();
