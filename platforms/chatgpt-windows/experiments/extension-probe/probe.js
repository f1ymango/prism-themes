(() => {
  if (location.protocol !== 'app:' || location.host !== '-') return;
  const install = () => {
    const element = document.createElement('div');
    element.id = 'prism-extension-loading-probe';
    element.hidden = true;
    document.documentElement.append(element);
    setTimeout(() => element.remove(), 120000);
  };
  if (document.documentElement) install();
  else document.addEventListener('DOMContentLoaded', install, { once: true });
})();
