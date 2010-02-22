var BarTap = {

  mPrefs: Components.classes['@mozilla.org/preferences-service;1']
          .getService(Components.interfaces.nsIPrefService).getBranch(null),

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

    /* When the user wants one or all tabs to reload, do the right thing
       in case it's tapped. */
    tabbrowser.reloadTab = function(aTab) {
      if (aTab.getAttribute("ontap") == "true") {
        BarTap.loadTabContents(aTab);
        return;
      }
      aTab.linkedBrowser.reload();
    };
    tabbrowser.reloadAllTabs = function() {
      for (var i = 0; i < this.mTabs.length; i++) {
        try {
          this.reloadTab(this.mTabs[i]);
        } catch (e) {
          // ignore failure to reload so others will be reloaded
        }
      }
    };

    /* Insert context menu item for putting tabs on your bar tab */
    let popup = document.getAnonymousElementByAttribute(tabbrowser, "anonid", "tabContextMenu");
    let menuitem = document.createElement('menuitem');
    menuitem.setAttribute('id', 'context_putOnTap');
    menuitem.setAttribute('label', 'Put on bar tab'); //XXX TODO l10n
    menuitem.setAttribute('tbattr', 'tabbrowser-multiple');
    menuitem.setAttribute('oncommand', "var tabbrowser = this.parentNode.parentNode.parentNode.parentNode; BarTap.putOnTap(tabbrowser.mContextTab);");
    let closetab = document.getAnonymousElementByAttribute(tabbrowser, "id", "context_closeTab");
    popup.insertBefore(menuitem, closetab);
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
          /* The referrer might be undefined. */
          let referrer = bartap.referrer;
          if (referrer) {
            referrer = makeURI(referrer);
          }
          /* Gotta love the inconsistency of this API */
          browser.loadURIWithFlags(bartap.uri, bartap.flags, referrer,
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
    this.loadTabContents(tab);
  },

  loadTabContents: function(tab) {
    /* Remove marker so that we can proceed loading the browser contents or,
       in case of about:blank where there's no event handler, continue to
       function normally. */
    tab.removeAttribute("ontap");

    let event = document.createEvent("Event");
    event.initEvent("BarTapLoad", true, true);
    tab.linkedBrowser.dispatchEvent(event);
  },

  putOnTap: function(tab) {
    if (tab.getAttribute("ontap") == "true") {
      return;
    }
    var sessionstore = Components.classes["@mozilla.org/browser/sessionstore;1"]
                       .getService(Components.interfaces.nsISessionStore);
    var state = sessionstore.getTabState(tab);
    var tabbrowser = this.getTabBrowserForTab(tab);
    var newtab = tabbrowser.addTab();
    tabbrowser.moveTabTo(newtab, tab._tPos);
    sessionstore.setTabState(newtab, state);
    /* Close the original tab.  We're taking the long way round to ensure the
       nsISessionStore service won't save this in the recently closed tabs. */
    tabbrowser._endRemoveTab(tabbrowser._beginRemoveTab(tab, true, null, false));
    tabbrowser.removeTab(tab);
    /* TODO: The tab that was selected before that should be selected again.
       What if it is the tab we just put on tab? */
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
  },

  getTabBrowserForTab: function(tab) {
    while (tab.localName != 'tabbrowser') {
      tab = tab.parentNode;
    }
    return tab;
  }

};

window.addEventListener("DOMContentLoaded", BarTap, false);
