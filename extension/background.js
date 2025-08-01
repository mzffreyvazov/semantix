/**
 * =================================================================================
 * Quick Definition - Background Service Worker
 * =================================================================================
 * This script handles all API communication and data processing.
 * 1. Listens for requests from the content script.
 * 2. Checks user settings to determine the dictionary source and display preferences.
 * 3. Fetches data from the appropriate API.
 * 4. Normalizes the data into a single, consistent format.
 * 5. Applies display preferences (scope, example count).
 * 6. Caches the final result and sends it back to the content script.
 */

// --- Data Normalization Functions ---

function normalizeMwData(mwData) {
  if (!mwData || mwData.length === 0 || typeof mwData[0] !== 'object') { return null; }
  const entry = mwData[0];
  const pronunciation = { lang: 'us', pron: '', url: '' };
  if (entry.hwi && entry.hwi.prs && entry.hwi.prs[0]) {
    pronunciation.pron = `/${entry.hwi.prs[0].mw}/`;
    if (entry.hwi.prs[0].sound) {
      const audioFile = entry.hwi.prs[0].sound.audio;
      const subdir = audioFile.startsWith("bix") ? "bix" : audioFile.startsWith("gg") ? "gg" : audioFile.match(/^_[0-9]/) ? "number" : audioFile.charAt(0);
      pronunciation.url = `https://media.merriam-webster.com/audio/prons/en/us/wav/${subdir}/${audioFile}.wav`;
    }
  }
  const definition = { pos: entry.fl || 'unknown', text: entry.shortdef[0] || 'No definition found.', example: [] };
  if (entry.suppl && entry.suppl.examples && entry.suppl.examples.length > 0) {
    const exampleText = entry.suppl.examples[0].t;
    definition.example.push({ text: exampleText.replace(/{it}|{\/it}/g, '') });
  } else if (entry.def && entry.def[0].sseq) {
    try { const firstSense = entry.def[0].sseq[0][0][1]; if (firstSense.dt && Array.isArray(firstSense.dt)) { const visExample = firstSense.dt.find(item => item[0] === 'vis'); if (visExample) { const exampleText = visExample[1][0].t.replace(/{wi}|{\/wi}/g, ''); definition.example.push({ text: exampleText }); } } } catch (e) { console.log("Could not parse 'vis' example from MW data:", e); }
  }
  return { word: entry.meta.id.split(':')[0], pos: [definition.pos], verbs: [], pronunciation: [pronunciation], definition: [definition] };
}

function normalizeGeminiData(aiData) {
  if (!aiData || !aiData.forms || aiData.forms.length === 0) {
    return null;
  }
  const definitions = aiData.forms.map(form => {
    const firstDef = form.definitions[0];
    return {
      pos: form.partOfSpeech || 'unknown',
      text: firstDef.definition || 'No definition text found.',
      translation: firstDef.definitionTranslation || null, // Add translation support
      example: firstDef.examples ? firstDef.examples.map(ex => ({
        text: typeof ex === 'string' ? ex : ex.text,
        translation: typeof ex === 'object' ? ex.translation : null // Add translation support for examples
      })) : []
    };
  });
  const pronunciation = { lang: 'us', pron: aiData.pronunciation || '', url: '' };
  return {
    word: aiData.word || aiData.phrase, // Handle both word and phrase properties
    translation: aiData.translation || null, // Add word/phrase translation
    pos: definitions.map(d => d.pos),
    verbs: [],
    pronunciation: [pronunciation],
    definition: definitions
  };
}

// --- Display Preferences Helper ---

function applyDisplayPreferences(data, settings) {
  const scope = settings.definitionScope || 'relevant';
  const count = settings.exampleCount !== undefined ? settings.exampleCount : 1;

  let definitionsToUse = [...data.definition];

  if (scope === 'relevant' && definitionsToUse.length > 1) {
    definitionsToUse = [definitionsToUse[0]];
  }

  const finalDefinitions = definitionsToUse.map(def => {
    const newDef = { ...def };
    if (newDef.example && newDef.example.length > count) {
      newDef.example = newDef.example.slice(0, count);
    }
    return newDef;
  });
  
  return { ...data, definition: finalDefinitions };
}

// --- Main Message Listener ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getDefinition') {
    const word = message.word.toLowerCase();

    chrome.storage.local.get(['preferredSource', 'mwApiKey', 'targetLanguage', 'definitionScope', 'exampleCount', 'ttsEnabled'], (settings) => {
      const source = settings.preferredSource || 'cambridge';
      const mwApiKey = settings.mwApiKey;
      const targetLanguage = settings.targetLanguage || 'none';
      const displaySettingsCacheKey = `qdp_${source}_${word}_${settings.definitionScope}_${settings.exampleCount}_${targetLanguage}`;

      chrome.storage.local.get(displaySettingsCacheKey, (result) => {
        if (result[displaySettingsCacheKey]) {
          console.log(`Found processed data in cache for "${word}" with current settings.`);
          sendResponse({ status: 'success', data: result[displaySettingsCacheKey], ttsEnabled: settings.ttsEnabled || false });
          return;
        }

        console.log(`Fetching "${word}" from API source: ${source}`);
        let apiPromise;

        if (source === 'gemini') {
          const encodedWord = encodeURIComponent(word);
          const langParam = targetLanguage && targetLanguage !== 'none' ? `?lang=${encodeURIComponent(targetLanguage)}` : '';
          const geminiUrl = `http://localhost:3000/api/gemini/${encodedWord}${langParam}`;
          
          // Check if it's a single word or phrase
          const words = word.split(/\s+/).filter(w => w.length > 0);
          const isPhrase = words.length > 1;
          
          if (isPhrase) {
            // For phrases, only fetch from Gemini (no Cambridge audio)
            apiPromise = fetch(geminiUrl)
              .then(res => res.json())
              .then(geminiData => {
                const normalizedGemini = normalizeGeminiData(geminiData);
                if (!normalizedGemini) throw new Error('Gemini AI definition not found or invalid format.');
                return normalizedGemini;
              });
          } else {
            // For single words, fetch from both Gemini and Cambridge for audio
            const cambridgeUrl = `http://localhost:3000/api/dictionary/en/${encodedWord}`;
            apiPromise = Promise.all([
              fetch(geminiUrl).then(res => res.json()),
              fetch(cambridgeUrl).then(res => res.json().catch(() => null)) // Prevent crash if Cambridge fails
            ]).then(([geminiData, cambridgeData]) => {
              const normalizedGemini = normalizeGeminiData(geminiData);
              if (!normalizedGemini) throw new Error('Gemini AI definition not found or invalid format.');
              if (cambridgeData && cambridgeData.pronunciation && cambridgeData.pronunciation.length > 0) {
                const cambridgePron = cambridgeData.pronunciation.find(p => p.url) || cambridgeData.pronunciation[0];
                if (cambridgePron) {
                  normalizedGemini.pronunciation[0].url = cambridgePron.url || '';
                  if (!normalizedGemini.pronunciation[0].pron && cambridgePron.pron) {
                    normalizedGemini.pronunciation[0].pron = cambridgePron.pron;
                  }
                }
              }
              return normalizedGemini;
            });
          }
        } else if (source === 'merriam-webster') {
          if (!mwApiKey) {
            sendResponse({ status: 'error', message: 'Merriam-Webster API key is not set.' });
            return;
          }
          const apiUrl = `https://www.dictionaryapi.com/api/v3/references/collegiate/json/${word}?key=${mwApiKey}`;
          apiPromise = fetch(apiUrl)
            .then(res => res.json())
            .then(data => normalizeMwData(data));
        } else {
          const apiUrl = `http://localhost:3000/api/dictionary/en/${word}`;
          apiPromise = fetch(apiUrl).then(res => res.json());
        }

        apiPromise.then(fullData => {
          if (!fullData || !fullData.word) {
            throw new Error('Definition not found or API returned invalid format.');
          }
          
          const finalData = applyDisplayPreferences(fullData, settings);

          chrome.storage.local.set({ [displaySettingsCacheKey]: finalData });
          sendResponse({ status: 'success', data: finalData, ttsEnabled: settings.ttsEnabled || false });
        }).catch(error => {
          console.error(`API Error for "${word}" from ${source}:`, error);
          sendResponse({ status: 'error', message: error.message });
        });
      });
    });

    return true;
  }
  
  if (message.type === 'translateSentence') {
    const sentence = message.text;

    chrome.storage.local.get(['targetLanguage', 'ttsEnabled'], (settings) => {
      const targetLanguage = settings.targetLanguage;
      
      // Check if no target language is set
      if (!targetLanguage || targetLanguage === 'none') {
        sendResponse({ status: 'noLanguage', message: 'Please select a target language in options setting to proceed' });
        return;
      }
      
      // Use a more robust encoding method that handles Unicode characters
      const encodedSentence = encodeURIComponent(sentence).replace(/[!'()*]/g, function(c) {
        return '%' + c.charCodeAt(0).toString(16);
      });
      const cacheKey = `qdp_sentence_${encodedSentence}_${targetLanguage}`;

      chrome.storage.local.get(cacheKey, (result) => {
        if (result[cacheKey]) {
          console.log(`Found sentence translation in cache.`);
          sendResponse({ status: 'success', data: result[cacheKey], ttsEnabled: settings.ttsEnabled || false });
          return;
        }

        console.log(`Translating sentence: "${sentence}"`);
        const encodedSentence = encodeURIComponent(sentence);
        const langParam = `?lang=${encodeURIComponent(targetLanguage)}`;
        const translateUrl = `http://localhost:3000/api/translate/${encodedSentence}${langParam}`;

        fetch(translateUrl)
          .then(res => res.json())
          .then(data => {
            if (data.error) {
              throw new Error(data.error);
            }
            
            chrome.storage.local.set({ [cacheKey]: data });
            sendResponse({ status: 'success', data: data, ttsEnabled: settings.ttsEnabled || false });
          })
          .catch(error => {
            console.error(`Translation Error for sentence:`, error);
            sendResponse({ status: 'error', message: error.message });
          });
      });
    });

    return true;
  }
});