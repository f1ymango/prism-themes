globalThis.__prismExtensionProbe = [];
const inspect = async () => {
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.url?.startsWith('app://-/')) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const element = document.createElement('div');
        element.id = 'prism-extension-loading-probe'; element.hidden = true;
        document.documentElement.append(element);
      } });
      globalThis.__prismExtensionProbe.push({ success: true });
    } catch (error) { globalThis.__prismExtensionProbe.push({ error: error.message }); }
  }
};
chrome.tabs.onUpdated.addListener(() => { inspect().catch(() => {}); });
inspect().catch(error => { globalThis.__prismExtensionProbe.push({ error: error.message }); });
