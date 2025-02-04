'use strict';

// Replace the following with your OpenAI API key (not secure for production)
const OPENAI_API_KEY = "INSERT_YOUR_OPENAI_API_KEY_HERE";

// --- Helper Functions ---
// ArrayBuffer <=> base64 conversion
function arrayBufferToBase64(buffer) {
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes.buffer;
}

// New Helper: Read file as Data URL (includes base64 and MIME type)
async function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
    reader.readAsDataURL(file);
  });
}

// New Helper: Convert Data URL to File object
function dataURLtoFile(dataurl, filename) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  const chunkSize = 16384; // 16KB chunks
  const chunks = [];
  
  for (let i = 0; i < bstr.length; i += chunkSize) {
    const chunk = new Uint8Array(bstr.slice(i, i + chunkSize).split('').map(c => c.charCodeAt(0)));
    chunks.push(chunk);
  }
  
  return new File(chunks, filename, { type: mime });
}

// New Helper: Convert Data URL to Blob
function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  const n = bstr.length;
  const u8arr = new Uint8Array(n);
  for (let i = 0; i < n; i++) u8arr[i] = bstr.charCodeAt(i);
  return new Blob([u8arr], { type: mime });
}

// Debug/inspect helper that appends messages into the inspect view
function updateInspectView(message) {
  const inspectDiv = document.getElementById("inspectView");
  if (inspectDiv) {
    const p = document.createElement("p");
    p.textContent = message;
    inspectDiv.appendChild(p);
  }
  console.log(message);
}

// Derive a key suitable for both encryption and decryption
async function getKeyMaterial(passphrase) {
  const encoder = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("KYC-Salt"),
      iterations: 100000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

// Encrypt text (typically your JSON KYC data) using AES-GCM
async function encryptData(data, passphrase) {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(JSON.stringify(data));
  const keyMaterial = await getKeyMaterial(passphrase);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    keyMaterial,
    encoded
  );
  const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.byteLength);
  return arrayBufferToBase64(combined.buffer);
}

// Decrypt text data (returning the decrypted JSON string)
async function decryptData(encryptedBase64, passphrase) {
  updateInspectView("Starting decryption...");
  try {
    const combinedBuffer = base64ToArrayBuffer(encryptedBase64);
    const combined = new Uint8Array(combinedBuffer);
    updateInspectView("Combined data length: " + combined.length);
    if (combined.length < 12) {
      throw new Error("Stored data is too short (missing IV).");
    }
    // Extract IV and ciphertext
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    updateInspectView("Attempting decryption...");
    const keyMaterial = await getKeyMaterial(passphrase);
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv },
      keyMaterial,
      ciphertext
    );
    const result = new TextDecoder().decode(decryptedBuffer);
    updateInspectView("Decryption succeeded!");
    return result;
  } catch (e) {
    console.error("Error in decryptData:", e);
    throw new Error("Decryption failed. Possibly the passphrase is incorrect or data is corrupted.");
  }
}

// Make an API call to OpenAI using the Chat Completions endpoint.
// Expects the prompt to instruct the model to output a JSON object mapping field indices to KYC keys.
async function callLLMForMapping(prompt, apiKey) {
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          // Instruct the model to output only plain JSON without any markdown formatting or extra commentary.
          content: prompt + "\n\nOutput only a JSON object with no markdown formatting or additional text."
        }]
      })
    });
    const data = await response.json();
    let mappingJson = data.choices[0].message.content;
    console.log("LLM mapping response:", mappingJson);

    // Preprocess the output: If the LLM returns markdown formatted JSON, strip out any code block markers.
    if (mappingJson.includes("```")) {
      // Remove triple backticks and anything before/after the JSON braces.
      const jsonStart = mappingJson.indexOf("{");
      const jsonEnd = mappingJson.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        mappingJson = mappingJson.substring(jsonStart, jsonEnd + 1);
      }
    }

    try {
      return JSON.parse(mappingJson);
    } catch (err) {
      // If JSON parsing fails, return the raw text.
      console.warn("JSON parsing failed, returning raw LLM output:", mappingJson);
      return mappingJson;
    }
  } catch (e) {
    console.error("Error calling LLM:", e);
    return {};
  }
}

// New Helper: Use LLM to validate and, if necessary, correct the phone country code.
async function validatePhoneCountryCodeLLM(kycData, openaiApiKey) {
  const country = kycData.country;
  const providedCode = kycData.phoneCountryCode;
  const prompt = `
You are an expert on international telephone dialing codes.
Given:
Country: ${country}
Provided Phone Country Code: ${providedCode}
Verify if the provided phone country code is correct for the specified country.
If it is correct, return the same code.
If it is not correct, return the correct phone country code.
Output your answer as a JSON object in the format {"phoneCountryCode": "<correct code>"} with no additional text.
`;
  console.log("LLM phone country code prompt:", prompt);

  try {
    const result = await callLLMForMapping(prompt, openaiApiKey);
    console.log("LLM phone country code result:", result);

    let phoneCode = providedCode;
    if (typeof result === "object" && result.phoneCountryCode) {
      phoneCode = result.phoneCountryCode;
    } else if (typeof result === "string") {
      try {
        const parsed = JSON.parse(result);
        if (parsed.phoneCountryCode) {
          phoneCode = parsed.phoneCountryCode;
        } else {
          console.warn("Parsed LLM response did not contain phoneCountryCode. Using provided code.");
        }
      } catch (e) {
        console.warn("Error parsing LLM response. Using provided code.", e);
      }
    }
    return phoneCode;
  } catch (error) {
    console.error("Error during LLM-based phone country code validation:", error);
    return providedCode;
  }
}

// --- Autofill and Save Functions ---
async function saveKYCData() {
  updateInspectView("Save button clicked");
  // Gather KYC details from the inputs
  const kycData = {
    firstName: document.getElementById("firstName").value,
    lastName: document.getElementById("lastName").value,
    email: document.getElementById("email").value,
    phoneCountryCode: document.getElementById("phoneCountryCode").value,
    phoneNumber: document.getElementById("phoneNumber").value,
    firstAddressLine: document.getElementById("firstAddressLine").value,
    secondAddressLine: document.getElementById("secondAddressLine").value,
    city: document.getElementById("city").value,
    postcode: document.getElementById("postcode").value,
    country: document.getElementById("country").value,
    dob: document.getElementById("dob").value
  };

  // Gather file documents for KYC if any
  const passportInput = document.getElementById("passport");
  const idFrontInput = document.getElementById("idFront");
  const idBackInput = document.getElementById("idBack");
  const selfieInput = document.getElementById("selfie");

  // Modify file handling in saveKYCData
  const storeFileWithRef = async (file, fieldName) => {
    if (!file) return null;
    const fileId = `${fieldName}_${Date.now()}`;
    await storeFile(fileId, file);
    return fileId;
  };

  kycData.passport = passportInput?.files[0] ? await storeFileWithRef(passportInput.files[0], 'passport') : null;
  kycData.idFront = idFrontInput?.files[0] ? await storeFileWithRef(idFrontInput.files[0], 'idFront') : null;
  kycData.idBack = idBackInput?.files[0] ? await storeFileWithRef(idBackInput.files[0], 'idBack') : null;
  kycData.selfie = selfieInput?.files[0] ? await storeFileWithRef(selfieInput.files[0], 'selfie') : null;

  const passphrase = document.getElementById("savePassphrase").value;
  if (!passphrase) {
    alert("Please enter the encryption passphrase for saving.");
    updateInspectView("Missing save passphrase");
    return;
  }
  try {
    const encrypted = await encryptData(kycData, passphrase);
    await cleanupOrphanedFiles(encrypted);
    chrome.storage.local.set({ encryptedKYC: encrypted }, () => {
      alert("KYC details and documents saved!");
      updateInspectView("Data saved successfully");
    });
  } catch (err) {
    console.error("Encryption error details:", err);
    updateInspectView("Encryption error: " + err.message);
    alert(`Failed to encrypt: ${err.message}`);
  }
}

async function autofillKYCData() {
  updateInspectView("Autofill button clicked");
  const passphrase = document.getElementById("autofillPassphrase").value;
  if (!passphrase) {
    alert("Please enter the encryption passphrase for autofill.");
    updateInspectView("Missing autofill passphrase");
    return;
  }
  chrome.storage.local.get("encryptedKYC", async (result) => {
    const encryptedData = result.encryptedKYC;
    if (!encryptedData) {
      alert("No KYC data found. Please save your details first.");
      updateInspectView("No encrypted KYC found in storage");
      return;
    }
    try {
      const decryptedString = await decryptData(encryptedData, passphrase);
      updateInspectView("Decryption successful: " + decryptedString);
      let kycData = JSON.parse(decryptedString);
      updateInspectView("JSON parsed successfully.");
      
      // Use LLM decisioning to validate and correct the phone country code.
      kycData.phoneCountryCode = await validatePhoneCountryCodeLLM(kycData, OPENAI_API_KEY);
      updateInspectView("Validated phone country code: " + kycData.phoneCountryCode);
      
      // Proceed with autofill by injecting kycData into the active tab.
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs[0];
        updateInspectView("Injecting autofill function on active tab");
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: autoFillFunction,
          args: [kycData, OPENAI_API_KEY]
        });
      });
    } catch (err) {
      updateInspectView("Error during autofill: " + err.message);
      alert("Autofill failed: " + err.message);
    }
  });
}

// The injected autofill function with AI integration.
// Uses callLLMForMapping to generate a mapping from field indices to KYC keys.
// The LLM prompt and result are logged to enhance debugging.
async function autoFillFunction(kycData, openaiApiKey) {
  // Add the missing function inside autoFillFunction
  async function selectCustomDropdownOption(buttonElement, targetValue) {
    const maxAttempts = 5;
    const waitBetweenAttempts = 500;
    const optionWaitTime = 1000; // Increased timeout for complex dropdowns
    const exactMatchThreshold = 0.95; // Minimum similarity score for fuzzy match
    targetValue = targetValue.trim().toLowerCase();

    // Helper to calculate text similarity
    function similarity(s1, s2) {
      const longer = s1.length > s2.length ? s1 : s2;
      const shorter = s1.length <= s2.length ? s1 : s2;
      const longerLength = longer.length;
      if (longerLength === 0) return 1.0;
      return (longerLength - editDistance(longer, shorter)) / parseFloat(longerLength);
    }

    // Levenshtein distance for fuzzy matching
    function editDistance(s1, s2) {
      s1 = s1.toLowerCase();
      s2 = s2.toLowerCase();
      const costs = [];
      for (let i = 0; i <= s1.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= s2.length; j++) {
          if (i === 0) costs[j] = j;
          else {
            if (j > 0) {
              let newValue = costs[j - 1];
              if (s1.charAt(i - 1) !== s2.charAt(j - 1))
                newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
              costs[j - 1] = lastValue;
              lastValue = newValue;
            }
          }
        }
        if (i > 0) costs[s2.length] = lastValue;
      }
      return costs[s2.length];
    }

    function isVisible(el) {
      return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }

    const eventsToSimulate = ["pointerdown", "mousedown", "pointerup", "mouseup", "click"];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      eventsToSimulate.forEach(eventType => {
        buttonElement.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
      });
      
      await new Promise(resolve => setTimeout(resolve, optionWaitTime));
      
      const options = Array.from(document.querySelectorAll("li, [role='option'], div[role='option'], span.option, button"));
      const visibleOptions = options.filter(el => el !== buttonElement && isVisible(el));

      let matchingOption = visibleOptions.find(opt => {
        const optText = opt.innerText ? opt.innerText.trim().toLowerCase() : "";
        // Priority 1: Exact match
        if (optText === targetValue) return true;
        // Priority 2: Case-insensitive exact match
        if (optText.toLowerCase() === targetValue.toLowerCase()) return true;
        // Priority 3: High similarity match
        return similarity(optText, targetValue) >= exactMatchThreshold;
      });

      // If multiple options match, find the closest one
      if (!matchingOption) {
        const scoredOptions = visibleOptions.map(opt => ({
          element: opt,
          score: similarity(opt.innerText.trim().toLowerCase(), targetValue)
        })).filter(o => o.score >= exactMatchThreshold);
        
        if (scoredOptions.length > 0) {
          scoredOptions.sort((a, b) => b.score - a.score);
          matchingOption = scoredOptions[0].element;
        }
      }

      if (matchingOption) {
        eventsToSimulate.forEach(eventType => {
          matchingOption.dispatchEvent(new MouseEvent(eventType, { bubbles: true, cancelable: true, view: window }));
        });
        matchingOption.click();
        matchingOption.dispatchEvent(new Event("change", { bubbles: true }));
        buttonElement.innerText = matchingOption.innerText.trim();
        return true;
      }

      await new Promise(resolve => setTimeout(resolve, waitBetweenAttempts));
    }
    return false;
  }

  // Local helper: callLLMForMapping
  async function callLLMForMapping(prompt, apiKey) {
    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [{
            role: "user",
            content: prompt + "\n\nOutput only a JSON object with no markdown formatting or additional text."
          }]
        })
      });
      const data = await response.json();
      let mappingJson = data.choices[0].message.content;
      console.log("LLM mapping response:", mappingJson);

      // Strip out markdown formatting if found.
      if (mappingJson.includes("```")) {
        const jsonStart = mappingJson.indexOf("{");
        const jsonEnd = mappingJson.lastIndexOf("}");
        if (jsonStart !== -1 && jsonEnd !== -1) {
          mappingJson = mappingJson.substring(jsonStart, jsonEnd + 1);
        }
      }

      try {
        return JSON.parse(mappingJson);
      } catch (err) {
        console.warn("JSON parsing failed, returning raw LLM output:", mappingJson);
        return mappingJson;
      }
    } catch (e) {
      console.error("Error calling LLM:", e);
      return {};
    }
  }

  console.log("Running autoFillFunction with data:", kycData);

  // Helper: check element visibility.
  function isVisible(el) {
    return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  }

  // 1. Gather a comprehensive list of candidate fields.
  // We cast a wide net over most interactive or editable elements.
  const candidateSelectors = [
    "input:not([type='hidden'])",
    "textarea",
    "select",
    "[contenteditable='true']",
    "button",
    "[role='textbox']",
    "[role='combobox']",
    "[aria-haspopup]",
    "[data-kyc-field]"
  ];
  const fieldCandidates = Array.from(document.querySelectorAll(candidateSelectors.join(", ")))
                              .filter(isVisible);
  const inputs = fieldCandidates.map((el, index) => ({
    element: el,
    index: index,
    tag: el.tagName,
    type: el.type || el.getAttribute("role") || "",
    name: el.name || el.id || "",
    // Prefer placeholder but also check for aria-label if available.
    placeholder: el.placeholder || el.getAttribute("aria-label") || "",
    // For buttons or non-inputs, use innerText.
    value: el.value || el.innerText || ""
  }));
  console.log("Total form fields detected (comprehensive): " + inputs.length);
  console.log("Form fields details:", inputs);

  if (inputs.length === 0) {
    console.log("No interactive fields found on the page. Exiting autofill.");
    return;
  }

  // 2. Build the LLM prompt for mapping field indices to KYC keys.
  // KYC keys: firstName, lastName, email, phoneCountryCode, phoneNumber, firstAddressLine, secondAddressLine, city, postcode, country, dob.
  const prompt = "I have the following form fields captured from a webpage:\n" +
    JSON.stringify(inputs, null, 2) +
    "\n\nThere are " + inputs.length + " fields in total. " +
    "Please return a JSON object that has an entry for every field index (from 0 to " + (inputs.length - 1) + "). " +
    "The value associated with each field index should be one of the following keys: firstName, lastName, email, phoneCountryCode, phoneNumber, firstAddressLine, secondAddressLine, city, postcode, country, dob, passport, idFront, idBack, selfie. " +
    "If a field does not clearly correspond to one of these keys, please set its value to null. " +
    "Output only a pure JSON object with no markdown formatting or additional text.";

  // 3. Get the mapping from the LLM.
  let mapping = {};
  try {
    mapping = await callLLMForMapping(prompt, openaiApiKey);
    console.log("Mapping returned from LLM:", mapping);
  } catch (e) {
    console.error("LLM mapping error:", e);
  }

  // 4. Fallback mapping using heuristics if the LLM mapping is empty or invalid.
  if (!mapping || Object.keys(mapping).length === 0) {
    console.log("Using fallback mapping using heuristics.");
    inputs.forEach((field, index) => {
      const lowerAttr = ((field.name || "") + " " + (field.id || "") + " " + (field.placeholder || "")).toLowerCase();
      if (lowerAttr.includes("first name") && kycData.firstName) {
        mapping[index] = "firstName";
      } else if (lowerAttr.includes("last name") && kycData.lastName) {
        mapping[index] = "lastName";
      } else if (lowerAttr.includes("email") && kycData.email) {
        mapping[index] = "email";
      } else if ((lowerAttr.includes("phone country") || lowerAttr.includes("country code")) && kycData.phoneCountryCode) {
        // If the field is mistakenly handled as a file input, use the file logic;
        // otherwise treat it as a text field.
        if (field.element.type === "file") {
          const dataUrl = kycData[kycKey];
          if (dataUrl) {
            const mimeMatch = dataUrl.match(/data:(.*?);/);
            let mimeType = mimeMatch ? mimeMatch[1] : "";
            let extension = "";
            if (mimeType === "image/jpeg") extension = ".jpg";
            else if (mimeType === "image/png") extension = ".png";
            else if (mimeType === "application/pdf") extension = ".pdf";
            const fileName = field.element.id + extension;
            const fileObj = dataURLtoFile(dataUrl, fileName);
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(fileObj);
            field.element.files = dataTransfer.files;
            field.element.dispatchEvent(new Event("change", { bubbles: true }));
            console.log(`File input at index ${field.index} filled with file ${fileName}`);
          }
        } else {
          field.element.value = kycData.phoneCountryCode;
          field.element.dispatchEvent(new Event("input", { bubbles: true }));
          console.log(`Field at index ${field.index} updated with phone country code "${kycData.phoneCountryCode}"`);
        }
      } else if ((lowerAttr.includes("phone") || lowerAttr.includes("contact")) && kycData.phoneNumber) {
        mapping[index] = "phoneNumber";
      } else if ((lowerAttr.includes("address line 1") || (lowerAttr.includes("address") && lowerAttr.includes("1"))) && kycData.firstAddressLine) {
        mapping[index] = "firstAddressLine";
      } else if ((lowerAttr.includes("address line 2") || (lowerAttr.includes("address") && lowerAttr.includes("2"))) && kycData.secondAddressLine) {
        mapping[index] = "secondAddressLine";
      } else if ((lowerAttr.includes("city") || lowerAttr.includes("town")) && kycData.city) {
        mapping[index] = "city";
      } else if ((lowerAttr.includes("postcode") || lowerAttr.includes("zip")) && kycData.postcode) {
        mapping[index] = "postcode";
      } else if ((lowerAttr.includes("country") && !lowerAttr.includes("phone")) && kycData.country) {
        mapping[index] = "country";
      } else if ((lowerAttr.includes("dob") || lowerAttr.includes("date")) && kycData.dob) {
        mapping[index] = "dob";
      } else if (lowerAttr.includes("passport") && kycData.passport) {
        mapping[index] = "passport";
      } else if ((lowerAttr.includes("id front") || lowerAttr.includes("front id") || lowerAttr.includes("idcard front")) && kycData.idFront) {
        mapping[index] = "idFront";
      } else if ((lowerAttr.includes("id back") || lowerAttr.includes("back id") || lowerAttr.includes("idcard back")) && kycData.idBack) {
        mapping[index] = "idBack";
      } else if (lowerAttr.includes("selfie") && kycData.selfie) {
        mapping[index] = "selfie";
      } else {
        mapping[index] = null;
      }
    });
    console.log("Fallback mapping used:", mapping);
  }

  // 5. Autofill the fields based on the mapping.
  for (const field of inputs) {
    const kycKey = mapping[field.index];
    if (kycKey && kycData[kycKey]) {
      if (field.element.type && field.element.type.toLowerCase() === "file") {
        const fileId = kycData[kycKey];
        if (fileId) {
          try {
            const storedFile = await retrieveFile(fileId);
            if (storedFile) {
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(new File([storedFile], storedFile.name, { 
                type: storedFile.type,
                lastModified: storedFile.lastModified 
              }));
              
              // Use requestIdleCallback for better performance
              await new Promise(resolve => {
                requestIdleCallback(() => {
                  field.element.files = dataTransfer.files;
                  ['change', 'input', 'blur'].forEach(eventType => {
                    field.element.dispatchEvent(new Event(eventType, { bubbles: true }));
                  });
                  resolve();
                });
              });
            }
          } catch (error) {
            console.error(`File retrieval error: ${error.message}`);
          }
        }
      } else if (field.element.tagName.toUpperCase() === "SELECT") {
        const targetValue = kycData[kycKey].toLowerCase();
        let optionFound = false;
        for (let option of field.element.options) {
          if ((option.value && option.value.toLowerCase() === targetValue) ||
              (option.text && option.text.toLowerCase() === targetValue)) {
            field.element.value = option.value;
            field.element.dispatchEvent(new Event("change", { bubbles: true }));
            optionFound = true;
            console.log(`Dropdown at index ${field.index} selected option "${option.text}"`);
            break;
          }
        }
        if (!optionFound) {
          console.log(`Dropdown at index ${field.index} did not find a matching option for ${kycData[kycKey]}`);
        }
      } else if (field.element.tagName.toUpperCase() === "BUTTON") {
        // Enhanced dropdown handling using LLM analysis
        const buttonPrompt = `Analyze this button's context to determine if it triggers a dropdown:
Button Text: "${field.element.innerText.trim()}"
Parent Container: ${field.element.parentElement.outerHTML.slice(0, 200)}
Nearby Elements: ${field.element.nextElementSibling?.outerHTML.slice(0, 100) || "none"}

Should this button open a dropdown to select "${kycData[kycKey]}" instead of performing an action? 
Consider that valid dropdown options are typically nouns (countries, states), while action buttons use verbs (back, submit). 
Respond with JSON: {"isDropdown": boolean, "targetValue": "${kycData[kycKey]}"}`;

        try {
          const dropdownAnalysis = await callLLMForMapping(buttonPrompt, openaiApiKey);
          
          if (dropdownAnalysis.isDropdown) {
            console.log(`Treating button at index ${field.index} as dropdown trigger for "${dropdownAnalysis.targetValue}"`);
            await selectCustomDropdownOption(field.element, dropdownAnalysis.targetValue);
          } else {
            console.log(`Updating plain button at index ${field.index} with value "${kycData[kycKey]}"`);
            field.element.innerText = kycData[kycKey];
            field.element.value = kycData[kycKey];
            field.element.dispatchEvent(new Event("input", { bubbles: true }));
          }
        } catch (error) {
          console.error("Error handling button:", error);
        }
      } else if (field.element.getAttribute("contenteditable") === "true") {
        if (field.element.innerText.trim() !== kycData[kycKey].trim()) {
          field.element.innerText = kycData[kycKey];
          field.element.dispatchEvent(new Event("input", { bubbles: true }));
          console.log(`Contenteditable field at index ${field.index} updated with "${kycData[kycKey]}"`);
        }
      } else {
        field.element.value = kycData[kycKey];
        field.element.dispatchEvent(new Event("input", { bubbles: true }));
        console.log(`Field at index ${field.index} filled with "${kycData[kycKey]}"`);
      }
    } else {
      console.log(`Field at index ${field.index} mapping is null or missing corresponding KYC data.`);
    }
  }

  // 6. Identify and click the "next action" button using LLM-assisted selection based on visible UI text.
  const candidateButtons = Array.from(document.querySelectorAll("button, input[type='button'], input[type='submit']"));
  console.log("Candidate buttons found:", candidateButtons.map(btn => btn.innerText || btn.value));

  async function selectNextButtonByText() {
    const candidateTexts = candidateButtons.map(btn => (btn.innerText || btn.value || "").trim());
    const buttonPrompt = `You are given a list of candidate button texts that appear on a web page:
${candidateTexts.join("\n")}

From this list, choose the button text that is most likely to represent the "next" action (e.g., "continue", "next", etc.). ` +
      `Output only the exact button text from the list that best matches this purpose. If none seem appropriate, output "none". ` +
      `Do not include any extra explanation. Output only a pure JSON object with no markdown formatting or additional text.`;
      
    try {
      const result = await callLLMForMapping(buttonPrompt, openaiApiKey);
      let selectedText = "";
      if (typeof result === "object" && result.buttonText) {
        selectedText = result.buttonText.trim();
      } else if (typeof result === "object" && result.index !== undefined) {
        selectedText = candidateTexts[result.index] || "";
      } else if (typeof result === "string") {
        selectedText = result.trim();
      }
      console.log("LLM chose candidate button text:", selectedText);
      return selectedText;
    } catch (error) {
      console.error("Error selecting candidate button via LLM:", error);
      return "none";
    }
  }

  const selectedCandidateText = await selectNextButtonByText();
  let chosenButton = null;
  if (selectedCandidateText && selectedCandidateText.toLowerCase() !== "none") {
    chosenButton = candidateButtons.find(btn => {
      const btnText = (btn.innerText || btn.value || "").trim().toLowerCase();
      return btnText === selectedCandidateText.toLowerCase();
    });
  }

  if (chosenButton) {
    console.log("LLM selected candidate button with text:", chosenButton.innerText || chosenButton.value);
    chosenButton.dispatchEvent(new MouseEvent("click", {
      view: window,
      bubbles: true,
      cancelable: true
    }));
    console.log("Candidate button automatically clicked.");
  } else {
    console.log("LLM did not select a valid candidate button. Falling back to keyword search.");
    const NEXT_KEYWORDS = ["next", "continue", "proceed"];
    const fallbackButton = candidateButtons.find(btn => {
      const text = (btn.innerText || btn.value || "").toLowerCase();
      return NEXT_KEYWORDS.some(keyword => text.includes(keyword));
    });
    if (fallbackButton) {
      console.log("Fallback candidate button found with text:", fallbackButton.innerText || fallbackButton.value);
      fallbackButton.dispatchEvent(new MouseEvent("click", {
        view: window,
        bubbles: true,
        cancelable: true
      }));
      console.log("Fallback candidate button automatically clicked.");
    } else {
      console.log("No candidate button found for next action.");
    }
  }

  console.log("Autofill process completed.");
}

// --- Event Listeners ---
document.getElementById("saveKYCButton").addEventListener("click", saveKYCData);
document.getElementById("autofillButton").addEventListener("click", autofillKYCData);

// Workaround to maintain the popup open during file uploads.
document.querySelectorAll('input[type="file"]').forEach(input => {
  input.addEventListener('mousedown', () => {
    chrome.action.setPopup({ popup: "" });
  });
  input.addEventListener('change', () => {
    setTimeout(() => {
      chrome.action.setPopup({ popup: "popup.html" });
    }, 500);
  });
});

// IndexedDB setup
const DB_NAME = 'KYCStorage';
const DB_VERSION = 1;
const FILE_STORE = 'kycFiles';

async function getDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeFile(id, file) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    tx.objectStore(FILE_STORE).put({ id, file });
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

async function retrieveFile(id) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(FILE_STORE, 'readonly');
    const request = tx.objectStore(FILE_STORE).get(id);
    request.onsuccess = () => resolve(request.result?.file);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function cleanupOrphanedFiles(encryptedData) {
  const allFiles = await getAllFileIds();
  const usedFiles = new Set(Object.values(JSON.parse(await decryptData(encryptedData, 'temp'))));
  
  const db = await getDB();
  return new Promise((resolve) => {
    const tx = db.transaction(FILE_STORE, 'readwrite');
    allFiles.forEach(id => {
      if (!usedFiles.has(id)) {
        tx.objectStore(FILE_STORE).delete(id);
      }
    });
    tx.oncomplete = () => resolve();
  });
}

// Enhanced UI feedback
function bytesToSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  if (bytes === 0) return '0 Byte';
  const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)), 10);
  return `${Math.round(bytes / Math.pow(1024, i), 2)} ${sizes[i]}`;
}

function showProgress(message) {
  updateInspectView(message);
  document.getElementById("autofillButton").disabled = true;
  document.getElementById("saveKYCButton").disabled = true;
}

