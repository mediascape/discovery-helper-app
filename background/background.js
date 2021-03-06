const SERVICE_TYPES = {
  MEDIASCAPE: '_mediascape-http._tcp.local',
  CAPI: '_capi._tcp.local'
};

var logToObject   = false,
    serviceTypes  = [SERVICE_TYPES.CAPI, SERVICE_TYPES.MEDIASCAPE],
    serviceCache  = {},
    recipients    = [];

// Override some logging functions
// to add to an array
var Logger = function (override, limit) {
  var logger = [];

  ['log', 'warn', 'error'].forEach(function(name) {
    override[name] = function () {
      logger.push(arguments);

      if (logger.length > limit) {
        logger.splice(0, logger.length - limit);
      }
    };
  });

  return logger;
};

if (logToObject) {
  var logger = Logger(console, 500);
}

/*
  Respond to other extension's requests for
  a complete service list
*/
chrome.runtime.onMessageExternal.addListener(function(message, sender) {
  if(recipients.indexOf(sender.id) == -1) {
    recipients.push(sender.id);
    sendMessage([sender.id], concatServices());
  }
});

serviceTypes.forEach(function(serviceType) {
  chrome.mdns.onServiceList.addListener(
    curryServiceListener(serviceType),
    {'serviceType': serviceType}
  );
});

function curryServiceListener(serviceType) {
  return function(services) {
    var mappedServices;

    function addServiceType(s) {
      s.serviceType = serviceType;

      return s;
    }

    mappedServices = services.map(addServiceType).map(transformTxtToKeys);

    console.log('Found %o for %s:', mappedServices.length, serviceType, mappedServices);
    updateRecipients(mappedServices, serviceType);
  }
}

function concatServices() {
  return Object.keys(serviceCache).reduce(function(prev, current) {
    return prev.concat(serviceCache[current]);
  }, []);
}

function updateRecipients(mappedServices, serviceType) {
  serviceCache[serviceType] = mappedServices;
  sendMessage(recipients, concatServices());
}

/*
  Parse a services TXT record values into
  key/value pairs on the `txt` object.
  e.g.  service.txt = ['id=15']
        => service.txt.id = 15

  Also attempts to parse JSON
  e.g.  service.txt = ['player={ id:15, name="dave"}']
        => service.txt.player.id = 15
           service.txt.player.name = "dave"
*/
function transformTxtToKeys(service) {
  var obj = {};

  service.host = service.serviceName.replace('.'+service.serviceType, '');
  service.address = service.ipAddress;
  service.port = service.serviceHostPort.split(':')[1];

  if (service.serviceData && service.serviceData.map) {
    service.serviceData.forEach(function (txt) {
      var parts = txt.split('='),
          key   = parts[0],
          value = parts[1] || true;

      try {
        value = JSON.parse(value);
      }
      catch (e) {
        // Ignore - value isn't JSON
      }

      obj[key] = value;
    });

    service.txt = obj;
  }

  switch (service.serviceType) {
    case SERVICE_TYPES.MEDIASCAPE:
      service.uri = 'http://' + service.serviceHostPort;
      break;
    case SERVICE_TYPES.CAPI:
      service.uri = 'ws://' + service.serviceHostPort + service.txt.Path;
      break;
  }

  return service;
}

function sendMessage(recievers, message) {
  recievers.forEach(function(recipient) {
    console.log('sending', recipient, message);
    chrome.runtime.sendMessage(
      recipient, message
    );
  });
}
