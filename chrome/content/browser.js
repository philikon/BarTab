var BarTap = {

  mPrefs: Components.classes['@mozilla.org/preferences-service;1']
          .getService(Ci.nsIPrefService).getBranch(null),

  handleEvent: function(event) {
    switch (event.type) {
    case 'DOMContentLoaded':
      this.init();
      return;
    case 'SSTabRestoring':
      this.onTabRestoring(event);
      return;
    case 'TabSelect':
      this.onTabSelect(event);
      return;
    }
  },

  init: function() {
    window.removeEventListener("DOMContentLoaded", this, false);
    window.addEventListener("SSTabRestoring", this, false);
    let tabbrowser = document.getElementById("content");
    this.initTabBrowser(tabbrowser);
  },

  /* This is deliberately its own method so that extensions that have
     other tabbrowsers can call it. */
  initTabBrowser: function(tabbrowser) {
    tabbrowser.addEventListener('TabSelect', this, false);

    /* Monkey patch our way into the tab browser.  This is by far the most
       efficient but also ugliest way :\ */
    eval('tabbrowser.mTabProgressListener = '+tabbrowser.mTabProgressListener.toSource().replace(
        /\{(this.mTab.setAttribute\("busy", "true"\);[^\}]+)\}/,
        'if (!BarTap.onTabStateChange(this.mTab)) { $1 }'
    ));

    eval('tabbrowser.addTab = '+tabbrowser.addTab.toSource().replace(
        'b.loadURIWithFlags(aURI, flags, aReferrerURI, aCharset, aPostData)',
        'BarTap.writeBarTap(t, b, aURI, flags, aReferrerURI, aCharset, aPostData); $&'
    ));
  },

  /* Called when the browser wants to load stuff into a tab.  If the tab has
     been placed on tap, stop the loading and defer to an event listener.
     Returns true of the tab has been tapped. */
  onTabStateChange: function(tab) {
    if (tab.getAttribute("ontap") != "true") {
      return false;
    }

    /* We need these here because they leak into the event listener below. */
    var browser = tab.linkedBrowser;
    var history = browser.webNavigation.sessionHistory;
    var bartap = browser.getAttribute("bartap");
    var gotoindex;
    var gotouri;

    browser.stop();

    if (bartap) {
      /* The tab was likely opened by clicking on a link */
      browser.removeAttribute("bartap");
      bartap = JSON.parse(bartap);
      gotouri = makeURI(bartap.uri);
    } else if (history.count) {
      /* Likely a restored tab, try loading from history. */
      gotoindex = history.requestedIndex;
      if (gotoindex == -1) {
        gotoindex = history.index;
      }
      gotouri = history.getEntryAtIndex(gotoindex, false).URI;
    } else if (browser.userTypedValue) {
      /* This might not make much sense here... */
      gotouri = makeURI(browser.userTypedValue);
    }

    if (gotouri) {
      /* See if we have title, favicon in stock for it. This should definitely
         work for restored tabs as they're in the history database. */
      let info = this.getInfoFromHistory(gotouri);
      if (info) {
        tab.setAttribute("image", info.icon);
        tab.label = info.title;
      } else {
        try {
          /* Set a meaningful part of the URI as tab label */
          let hostPort = gotouri.hostPort;
          let path = gotouri.path;
          if (hostPort.substr(0, 4) == "www.") {
            hostPort = hostPort.substr(4);
          }
          if (path == "/") {
            path = "";
          }
          tab.label = hostPort + path;
        } catch (ex) {
          /* Most likely gotouri.hostPort and gotouri.path failed.
             Let's handle this gracefully. */
          tab.label = gotouri.spec;
        }
      }
    }

    browser.addEventListener("BarTapLoad", function() {
        browser.removeEventListener("BarTapLoad", arguments.callee, false);

        if (bartap) {
          /* Gotta love the inconsistency of this API */
          browser.loadURIWithFlags(
            bartap.uri, bartap.flags,
            makeURI(bartap.referrer),
            bartap.charset, bartap.postdata);
        } else if (history.count) {
          browser.webNavigation.gotoIndex(gotoindex);
        } else if (browser.userTypedValue) {
          /* This might not make much sense here... */
          browser.loadURI(browser.userTypedValue);
        }
      }, false);

    return true;
  },

  onTabSelect: function(event) {
    var tab = event.originalTarget;
    if (tab.getAttribute("ontap") != "true") {
      return;
    }
    /* Remove marker so that we can proceed loading the browser contents or,
       in case of about:blank where there's no event handler, continue to
       function normally. */
    tab.removeAttribute("ontap");

    let event = document.createEvent("Event");
    event.initEvent("BarTapLoad", true, true);
    tab.linkedBrowser.dispatchEvent(event);
  },

  /* Called when a tab is opened with a new URI (e.g. by opening a link in
     a new tab.) Stores the parameters on the tab so that 'onTabStateChange'
     can carry out the action later. */
  writeBarTap: function(aTab, aBrowser, aURI, aFlags, aReferrerURI, aCharset, aPostData) {
    if (aURI && this.mPrefs.getBoolPref("extensions.bartap.tapBackgroundTabs")) {
      let bartap = "";
      if (aURI) {
        bartap = JSON.stringify({
          uri:      (aURI instanceof Ci.nsIURI) ? aURI.spec : aURI,
          flags:    aFlags,
          referrer: (aReferrerURI instanceof Ci.nsIURI) ? aReferrerURI.spec : aReferrerURI,
          charset:  aCharset,
          postdata: aPostData
        });
      }
      aTab.setAttribute("ontap", "true");
      aBrowser.setAttribute("bartap", bartap);
    }
  },

  /* Listens to the 'SSTabRestoring' event from the nsISessionStore service
     and puts a marker on restored tabs. */
  onTabRestoring: function(event) {
    if (!this.mPrefs.getBoolPref("extensions.bartap.tapRestoredTabs")) {
      return;
    }
    let tab = event.originalTarget;
    if (tab.selected) {
      return;
    }
    tab.setAttribute("ontap", "true");
  },

  /* Get information about a URI from the history service,
     e.g. title, favicon, ... */
  getInfoFromHistory: function(aURI) {
    var history = Cc["@mozilla.org/browser/nav-history-service;1"]
                    .getService(Ci.nsINavHistoryService);

    var options = history.getNewQueryOptions();
    options.queryType = 0;   // search history
    options.maxResults = 1;

    var query = history.getNewQuery();
    query.uri = aURI;

    var result = history.executeQuery(query, options);
    result.root.containerOpen = true;

    if (!result.root.childCount) {
      return null;
    }
    return result.root.getChild(0);
  }

};

window.addEventListener("DOMContentLoaded", BarTap, false);
