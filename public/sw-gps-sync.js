/* Service Worker Background Sync helper for Al-Waleed Travel offline GPS buffering */
self.addEventListener('sync', function (event) {
  if (event.tag === 'alwaleed-gps-sync') {
    event.waitUntil(flushOfflineGpsQueue());
  }
});

function openAlWaleedDb() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('alwaleed_local_store', 1);
    req.onsuccess = function () {
      resolve(req.result);
    };
    req.onerror = function () {
      reject(req.error);
    };
  });
}

function getAllFromStore(db, storeName) {
  return new Promise(function (resolve) {
    try {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).getAll();
      req.onsuccess = function () {
        resolve(req.result || []);
      };
      req.onerror = function () {
        resolve([]);
      };
    } catch (_e) {
      resolve([]);
    }
  });
}

function getByKey(db, storeName, key) {
  return new Promise(function (resolve) {
    try {
      var tx = db.transaction(storeName, 'readonly');
      var req = tx.objectStore(storeName).get(key);
      req.onsuccess = function () {
        resolve(req.result || null);
      };
      req.onerror = function () {
        resolve(null);
      };
    } catch (_e) {
      resolve(null);
    }
  });
}

function deleteIds(db, storeName, ids) {
  return new Promise(function (resolve) {
    if (!ids.length) return resolve();
    try {
      var tx = db.transaction(storeName, 'readwrite');
      var store = tx.objectStore(storeName);
      ids.forEach(function (id) {
        store.delete(id);
      });
      tx.oncomplete = function () {
        resolve();
      };
      tx.onerror = function () {
        resolve();
      };
    } catch (_e) {
      resolve();
    }
  });
}

async function flushOfflineGpsQueue() {
  try {
    var db = await openAlWaleedDb();
    var tokenRow = await getByKey(db, 'auth_meta', 'session_token');
    if (!tokenRow || !tokenRow.token) return;

    var points = await getAllFromStore(db, 'gps_queue');
    if (!points.length) return;

    var batch = points.slice(0, 100);
    var res = await fetch('/api/gps/sync-batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + tokenRow.token,
      },
      body: JSON.stringify({ points: batch }),
    });

    if (res.ok) {
      var ids = batch
        .map(function (p) {
          return p.id;
        })
        .filter(function (id) {
          return typeof id === 'number';
        });
      await deleteIds(db, 'gps_queue', ids);
    }
  } catch (_err) {
    // Will retry automatically on next sync event or when app regains connectivity
  }
}

self.addEventListener('message', function (event) {
  var data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SHOW_BG_NOTIFICATION' && data.payload && self.registration) {
    var p = data.payload;
    var title = p.title || 'إشعار جديد · الوليد ترافيل';
    var options = {
      body: p.body || '',
      icon: '/pwa-192x192.png',
      badge: '/pwa-192x192.png',
      dir: 'rtl',
      lang: 'ar',
      tag: p.tag || 'alwaleed-driver-notif-' + (p.id || Date.now()),
      renotify: true,
      vibrate: [200, 100, 200],
      data: {
        url: p.url || '/',
        notificationId: p.id || null,
      },
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          client.postMessage({ type: 'OPEN_DRIVER_NOTIFICATIONS' });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

