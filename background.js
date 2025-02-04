// Initialize alarms first
chrome.alarms || console.error('Alarms API unavailable');

// Then create keepAlive alarm
chrome.runtime.onInstalled.addListener(() => {
  console.log('Service worker installed');
  chrome.alarms.create('keepAlive', { 
    periodInMinutes: 0.1, // Faster for testing
    delayInMinutes: 0.01
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('Alarm triggered:', alarm.name);
  if (alarm.name === 'keepAlive') {
    console.log('Service worker keep-alive ping');
  }
});

// Popup focus handler
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === "keepPopupOpen") {
    chrome.windows.getCurrent(w => {
      chrome.windows.update(w.id, {focused: true, state: 'maximized'});
    });
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && 
     !tab.url.startsWith('chrome://') &&
     !tab.url.startsWith('edge://') &&
     !tab.url.startsWith('about:')) {
    chrome.scripting.executeScript({
      target: { tabId },
      files: ['contentScript.js']
    });
  }
}); 