document.addEventListener('DOMContentLoaded', () => {
  const status = document.querySelector('.status');
  if (!status) return;

  const updateStatus = (result) => {
    const active = !!(result.ag4_running || result.ag4_resume);
    status.textContent = active ? 'Automation running' : 'Prompt watchdog idle';
    status.dataset.state = active ? 'on' : 'off';
  };

  chrome.storage.local.get(['ag4_running', 'ag4_resume'], updateStatus);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.ag4_running && !changes.ag4_resume) return;
    chrome.storage.local.get(['ag4_running', 'ag4_resume'], updateStatus);
  });
});