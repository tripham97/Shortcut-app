const input = document.getElementById('searchInput');
const suggestions = document.getElementById('appSuggestions');
let appResults = [];
let selectedIndex = 0;

function isAppCommand(value) {
  return value.trim().toLowerCase().startsWith('/app');
}

function getAppQuery(value) {
  return value.trim().slice(4).trim();
}

function updateWindowHeight() {
  const expanded = !suggestions.hidden;
  const baseHeight = 96;
  const expandedHeight = Math.min(320, Math.max(baseHeight, suggestions.scrollHeight + 68));
  window.electronAPI.setWindowHeight(expanded ? expandedHeight : baseHeight);
}

function hideSuggestions() {
  appResults = [];
  selectedIndex = 0;
  suggestions.hidden = true;
  suggestions.innerHTML = '';
  updateWindowHeight();
}

async function launchSelectedApp(index) {
  const match = appResults[index];
  if (!match) {
    return;
  }

  await window.electronAPI.launchApp(match);
  hideSuggestions();
}

function renderSuggestions() {
  if (!appResults.length) {
    hideSuggestions();
    return;
  }

  suggestions.innerHTML = '';

  appResults.forEach((result, index) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'suggestion-item';
    if (index === selectedIndex) {
      item.classList.add('active');
    }
    item.textContent = result.name;
    item.addEventListener('click', () => {
      void launchSelectedApp(index);
    });
    suggestions.appendChild(item);
  });

  suggestions.hidden = false;
  updateWindowHeight();

  const activeItem = suggestions.children[selectedIndex];
  if (activeItem) {
    activeItem.scrollIntoView({ block: 'nearest' });
  }
}

async function refreshAppSuggestions() {
  if (!isAppCommand(input.value)) {
    hideSuggestions();
    return;
  }

  appResults = await window.electronAPI.searchApps(getAppQuery(input.value));
  selectedIndex = 0;
  renderSuggestions();
}

input.addEventListener('input', () => {
  void refreshAppSuggestions();
});

input.addEventListener('keydown', (e) => {
  if (isAppCommand(input.value) && !suggestions.hidden) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = (selectedIndex + 1) % appResults.length;
      renderSuggestions();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = (selectedIndex - 1 + appResults.length) % appResults.length;
      renderSuggestions();
      return;
    }
  }

  if (e.key === 'Enter') {
    const query = input.value.trim();
    if (!query) {
      return;
    }

    if (isAppCommand(query)) {
      e.preventDefault();
      void launchSelectedApp(selectedIndex);
      return;
    }

    window.electronAPI.search(query);
  }

  if (e.key === 'Escape') {
    if (!suggestions.hidden) {
      hideSuggestions();
      return;
    }

    window.close();
  }
});

window.electronAPI.onFocusInput(() => {
  input.value = '';
  input.focus();
  hideSuggestions();
});
