(function() {
  "use strict";

  var CONFIG = {
    endpoint: "/api/scoreboard",
    refreshMs: 30000,
    cacheKey: "ballknower:lastScoreboard",
  };

  var state = {
    games: [],
    selectedIndex: 0,
    loading: false,
    timer: null,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function setupEvents() {
    document.addEventListener("keydown", function(event) {
      switch (event.key) {
        case "ArrowLeft":
          selectGame(state.selectedIndex - 1);
          event.preventDefault();
          break;
        case "ArrowRight":
          selectGame(state.selectedIndex + 1);
          event.preventDefault();
          break;
        case "Enter":
          loadScoreboard({ force: true });
          event.preventDefault();
          break;
      }
    });

    document.addEventListener("visibilitychange", function() {
      if (document.hidden) {
        stopAutoRefresh();
      } else {
        loadScoreboard({ silent: true });
        startAutoRefresh();
      }
    });
  }

  function loadCachedScoreboard() {
    try {
      var cached = JSON.parse(localStorage.getItem(CONFIG.cacheKey) || "null");
      if (cached && Array.isArray(cached.games)) {
        applyScoreboard(cached, { cached: true });
      }
    } catch (error) {
      localStorage.removeItem(CONFIG.cacheKey);
    }
  }

  function saveCachedScoreboard(data) {
    try {
      localStorage.setItem(CONFIG.cacheKey, JSON.stringify(data));
    } catch (error) {
      // The app can still run without local storage.
    }
  }

  function loadScoreboard(options) {
    options = options || {};
    if (state.loading) return;

    state.loading = true;
    setLoading(!options.silent && state.games.length === 0);
    clearError();
    setPill("Loading", "");

    fetch(CONFIG.endpoint + (options.force ? "?t=" + Date.now() : ""), {
      cache: options.force ? "no-store" : "default",
    })
      .then(function(response) {
        return response.json().catch(function() {
          return {};
        }).then(function(data) {
          if (!response.ok) {
            throw new Error(data.error || ("Score service " + response.status));
          }
          return data;
        });
      })
      .then(function(data) {
        saveCachedScoreboard(data);
        applyScoreboard(data);
      })
      .catch(function(error) {
        setPill("Offline", "error");
        if (state.games.length === 0) {
          setError(error.message || "Unable to load scores");
        }
      })
      .finally(function() {
        state.loading = false;
        setLoading(false);
      });
  }

  function applyScoreboard(data, options) {
    options = options || {};
    state.games = Array.isArray(data.games) ? data.games : [];
    if (state.selectedIndex >= state.games.length) state.selectedIndex = 0;
    renderCurrentGame(data, options);
  }

  function selectGame(index) {
    if (state.games.length === 0) return;
    state.selectedIndex = (index + state.games.length) % state.games.length;
    renderCurrentGame();
  }

  function renderCurrentGame(data, options) {
    var games = state.games;
    var game = games[state.selectedIndex];
    var hasGames = Boolean(game);

    $("game-card").classList.toggle("hidden", !hasGames);
    $("empty-state").classList.toggle("hidden", hasGames);

    if (!hasGames) {
      setPill(options && options.cached ? "Cached" : "No games", "");
      $("game-count").textContent = "0 of 0";
      return;
    }

    var status = statusLabel(game);
    setPill(status.compact, status.isLive ? "live" : "");
    $("game-status").textContent = status.label;
    $("game-status").classList.toggle("live", status.isLive);
    $("game-count").textContent = (state.selectedIndex + 1) + " of " + games.length;

    $("away-code").textContent = game.away.code;
    $("away-name").textContent = game.away.name;
    $("away-score").textContent = scoreText(game.away.score);
    $("home-code").textContent = game.home.code;
    $("home-name").textContent = game.home.name;
    $("home-score").textContent = scoreText(game.home.score);
    $("game-clock").textContent = gameClock(game);
    $("game-arena").textContent = game.arena || "";

    $("away-row").classList.toggle("leading", Number(game.away.score) > Number(game.home.score));
    $("home-row").classList.toggle("leading", Number(game.home.score) > Number(game.away.score));
  }

  function statusLabel(game) {
    var text = game.statusText || "";
    var phase = Number(game.status);
    var isLive = phase === 2 || /Q|Half|OT|LIVE/i.test(text);
    var isFinal = phase === 3 || /final/i.test(text);

    if (isLive) return { label: text || "Live", compact: "Live", isLive: true };
    if (isFinal) return { label: text || "Final", compact: "Final", isLive: false };
    return { label: text || "Pregame", compact: "Ready", isLive: false };
  }

  function gameClock(game) {
    if (game.period && game.clock) return "Q" + game.period + " " + game.clock;
    if (game.period) return "Q" + game.period;
    return game.startTime || "TBD";
  }

  function scoreText(value) {
    var score = Number(value);
    return Number.isFinite(score) ? String(score) : "0";
  }

  function setLoading(isLoading) {
    $("loading").classList.toggle("hidden", !isLoading);
  }

  function setError(message) {
    $("error").classList.remove("hidden");
    $("game-card").classList.add("hidden");
    $("empty-state").classList.add("hidden");
    $("error").querySelector(".error-message").textContent = message;
  }

  function clearError() {
    $("error").classList.add("hidden");
  }

  function setPill(text, type) {
    // The app has no chrome; keep the score window as the only visible surface.
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    state.timer = window.setInterval(function() {
      loadScoreboard({ silent: true });
    }, CONFIG.refreshMs);
  }

  function stopAutoRefresh() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }

  function init() {
    setupEvents();
    registerServiceWorker();
    loadCachedScoreboard();
    loadScoreboard({ force: true });
    startAutoRefresh();
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(function() {
      // Static caching is optional; live scores still work without it.
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
