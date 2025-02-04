let observerActive = true;

const observer = new MutationObserver(() => {
  if (observerActive) {
    handlePage();
  }
});

async function handlePage() {
  const fields = await findAutoFillCandidates();
  if (fields.length > 0) {
    await fillFields(fields);
    await clickContinue();
    observerActive = true; // Reset for next page
  } else {
    observerActive = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'startAutofill') {
    isAutofillActive = true;
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true
    });
    handlePage();
  }
}); 