// Clicking the icon opens the side panel, which runs everything. Alt+Shift+F fills the current page.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

chrome.commands.onCommand.addListener(async (cmd, tab) => {
  if (cmd !== 'fill-now' || !tab) return;
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  setTimeout(() => chrome.runtime.sendMessage({ type: 'cmd-fill' }).catch(() => {}), 700);
});
