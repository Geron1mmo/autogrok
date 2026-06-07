document.addEventListener('DOMContentLoaded', () => {
  const status = document.querySelector('.status');
  if (status) {
    chrome.storage.local.get(['watchdogActive'], (result) => {
      const active = result.watchdogActive !== false;
      status.textContent = active ? 'Prompt watchdog active' : 'Watchdog paused';
    });
  }
});