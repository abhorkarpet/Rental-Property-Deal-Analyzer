(function() {
  'use strict';

  var STEP_ROUTES = {
    1: 'analyze/property',
    2: 'analyze/loan',
    3: 'analyze/income',
    4: 'analyze/expenses',
    5: 'analyze/review'
  };
  var ROUTE_STEPS = {
    'analyze/property': 1,
    'analyze/loan': 2,
    'analyze/income': 3,
    'analyze/expenses': 4,
    'analyze/review': 5
  };
  var RESULT_VIEWS = ['summary', 'whatif', 'details'];
  var currentRoute = '';
  var analysisOrigin = 'analyze';
  var applyingRoute = false;
  var scrollPositions = {};

  function byId(id) { return document.getElementById(id); }

  function normalizeRoute(route) {
    route = String(route || '').replace(/^#\/?/, '').replace(/\/$/, '');
    if (route === 'analyze') return 'analyze/property';
    if (route === 'find') return 'find/neighborhood';
    if (ROUTE_STEPS[route]) return route;
    if (route === 'batch' || route === 'find/neighborhood' || route === 'find/smart') return route;
    if (route.indexOf('results/') === 0 && RESULT_VIEWS.indexOf(route.split('/')[1]) >= 0) return route;
    return 'analyze/property';
  }

  function workspaceFor(route) {
    if (route === 'batch') return 'batch';
    if (route.indexOf('find/') === 0) return 'find';
    return 'analyze';
  }

  function scrollKey(route) {
    var workspace = workspaceFor(route);
    return workspace === 'analyze' ? 'analyze' : route;
  }

  function rememberScroll(route) {
    if (route) scrollPositions[scrollKey(route)] = window.scrollY || 0;
  }

  function restoreScroll(route) {
    var top = scrollPositions[scrollKey(route)];
    if (top == null) top = 0;
    window.requestAnimationFrame(function() {
      window.requestAnimationFrame(function() { window.scrollTo({ top: top, behavior: 'auto' }); });
    });
  }

  function writeHash(route, replace) {
    var hash = '#' + route;
    if (window.location.hash === hash) return;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', hash);
  }

  function renderChrome(route) {
    var workspace = workspaceFor(route);
    var analysisStep = ROUTE_STEPS[route] || (route.indexOf('results/') === 0 ? 6 : 1);
    document.querySelectorAll('#workspaceNav [data-workspace]').forEach(function(button) {
      var active = button.dataset.workspace === workspace;
      button.classList.toggle('active', active);
      button.setAttribute('aria-current', active ? 'page' : 'false');
    });

    var analysisChrome = workspace === 'analyze';
    var wizard = byId('wizardNav');
    var scenarios = byId('scenarioToolbar');
    if (wizard) wizard.style.display = analysisChrome ? '' : 'none';
    if (scenarios) scenarios.style.display = analysisChrome ? '' : 'none';

    var modeToggle = byId('modeToggle');
    if (modeToggle) modeToggle.style.display = workspace === 'find' ? '' : 'none';
    var smartEntryToggle = byId('smartEntryToggle');
    if (smartEntryToggle) smartEntryToggle.style.display = 'none';
    var smartTitle = byId('smartModeTitle');
    if (smartTitle) smartTitle.textContent = workspace === 'batch' ? 'Batch Review' : 'Smart Deal Finder';

    var context = byId('analysisContext');
    if (context) {
      var showContext = analysisChrome && (analysisStep > 1 || analysisOrigin !== 'analyze');
      context.hidden = !showContext;
      if (showContext) {
        var back = byId('analysisOriginBack');
        var label = byId('analysisContextLabel');
        var originLabels = {
          'batch': 'Batch Review',
          'find/neighborhood': 'Neighborhood Search',
          'find/smart': 'Smart Deal Finder'
        };
        var originLabel = originLabels[analysisOrigin];
        if (back) {
          back.hidden = !originLabel;
          back.textContent = originLabel ? '\u2190 Back to ' + originLabel : '\u2190 Back';
        }
        if (label) label.textContent = originLabel ? 'Analyzing a deal from ' + originLabel : 'Property analysis';
      }
    }
  }

  function applyRoute(route, options) {
    options = options || {};
    route = normalizeRoute(route);
    applyingRoute = true;
    try {
      if (route === 'batch') {
        window.goToStep(1);
        window.toggleSearchMode('smart');
        window.showSmartEntry('batch');
      } else if (route === 'find/neighborhood') {
        window.goToStep(1);
        window.toggleSearchMode('search');
      } else if (route === 'find/smart') {
        window.goToStep(1);
        window.toggleSearchMode('smart');
        window.showSmartEntry('discover');
      } else {
        window.toggleSearchMode('single');
        if (route.indexOf('results/') === 0) {
          window.goToStep(6);
          window.showResultsView(route.split('/')[1]);
        } else {
          window.goToStep(ROUTE_STEPS[route] || 1);
        }
      }
      currentRoute = route;
      renderChrome(route);
    } finally {
      applyingRoute = false;
    }
    if (options.restoreScroll !== false) restoreScroll(route);
  }

  function navigate(route, options) {
    options = options || {};
    route = normalizeRoute(route);
    if (route === 'analyze/property' && workspaceFor(currentRoute) !== 'analyze' && !options.preserveOrigin) {
      analysisOrigin = 'analyze';
    }
    if (route !== currentRoute) rememberScroll(currentRoute);
    writeHash(route, !!options.replace);
    applyRoute(route, options);
  }

  function syncFromApp(route) {
    route = normalizeRoute(route);
    if (route === currentRoute) {
      renderChrome(route);
      return;
    }
    rememberScroll(currentRoute);
    currentRoute = route;
    writeHash(route, false);
    renderChrome(route);
  }

  function originRoute() {
    if (analysisOrigin === 'batch') return 'batch';
    if (analysisOrigin === 'find/neighborhood' || analysisOrigin === 'find/smart') return analysisOrigin;
    return 'analyze/property';
  }

  window.AppNavigation = {
    navigate: navigate,
    setAnalysisOrigin: function(origin) {
      analysisOrigin = origin || 'analyze';
      renderChrome(currentRoute || 'analyze/property');
    },
    backToOrigin: function() { navigate(originRoute(), { preserveOrigin: true }); },
    editAnalysis: function() { navigate('analyze/property', { preserveOrigin: true }); },
    startAnother: function() {
      if (!window.confirm('Start a new property analysis? Your imported batch and search results will be kept.')) return;
      if (window.resetAnalysisForNewProperty) window.resetAnalysisForNewProperty();
      analysisOrigin = 'analyze';
      navigate('analyze/property', { preserveOrigin: true });
    },
    currentRoute: function() { return currentRoute; }
  };

  document.addEventListener('app:navigation-change', function(event) {
    if (applyingRoute) return;
    var detail = event.detail || {};
    if (detail.type === 'step') {
      syncFromApp(detail.step === 6 ? 'results/summary' : (STEP_ROUTES[detail.step] || 'analyze/property'));
    } else if (detail.type === 'resultsView') {
      syncFromApp('results/' + detail.view);
    } else if (detail.type === 'mode') {
      if (detail.mode === 'single') syncFromApp('analyze/property');
      if (detail.mode === 'search') syncFromApp('find/neighborhood');
    } else if (detail.type === 'smartEntry') {
      syncFromApp(detail.entry === 'batch' ? 'batch' : 'find/smart');
    }
  });

  window.addEventListener('popstate', function() {
    rememberScroll(currentRoute);
    applyRoute(window.location.hash, { restoreScroll: true });
  });

  var initialRoute = normalizeRoute(window.location.hash);
  writeHash(initialRoute, true);
  applyRoute(initialRoute, { restoreScroll: false });
})();
