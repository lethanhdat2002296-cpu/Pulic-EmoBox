const { setCors } = require('../lib/db');

const routes = {
  '/api/health': require('../_api/health'),
  '/api/orders': require('../_api/orders'),
  '/api/bank-card/get': require('../_api/bank-card/get'),
  '/api/bank-card/save': require('../_api/bank-card/save'),
  '/api/email/gift-schedule': require('../_api/email/gift-schedule'),
  '/api/email/registration': require('../_api/email/registration'),
  '/api/email/status': require('../_api/email/status'),
  '/api/gift-schedules': require('../_api/gift-schedules'),
  '/api/gift-schedules/delete': require('../_api/gift-schedules/delete'),
  '/api/gift-schedules/list': require('../_api/gift-schedules/list'),
  '/api/subscriptions/activate': require('../_api/subscriptions/activate'),
  '/api/users/login': require('../_api/users/login'),
  '/api/users/upsert': require('../_api/users/upsert'),
  '/api/wallet/deposit': require('../_api/wallet/deposit'),
  '/api/wallet/history': require('../_api/wallet/history'),
  '/api/wallet/withdraw': require('../_api/wallet/withdraw')
};

function cleanRoute(value) {
  if (!value) return '';
  let route = String(value).trim();
  if (!route) return '';

  if (/^https?:\/\//i.test(route)) {
    route = new URL(route).pathname;
  }

  route = route.split('?')[0].replace(/\\/g, '/').replace(/^\/+/, '');
  if (!route) return '';
  if (route === 'api') return '/api';
  if (!route.startsWith('api/')) route = `api/${route}`;
  return `/${route.replace(/\/+$/, '')}`;
}

function routeFromBody(req) {
  if (!req.body) return '';
  const body = typeof req.body === 'string' ? safeJson(req.body) : req.body;
  return cleanRoute(body && (body.route || body.path || body._route));
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return {};
  }
}

function resolveRoute(req) {
  const url = new URL(req.url || '/api', 'http://localhost');
  return (
    routeFromBody(req) ||
    cleanRoute(url.searchParams.get('path')) ||
    cleanRoute(url.searchParams.get('route')) ||
    cleanRoute(url.pathname)
  );
}

module.exports = async function handler(req, res) {
  const route = resolveRoute(req);

  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }

  if (route === '/api') {
    setCors(res);
    return res.status(200).json({
      ok: true,
      service: 'EmoBox API',
      routes: Object.keys(routes).length
    });
  }

  const routeHandler = routes[route] || routes[route.replace(/\/index$/, '')];
  if (!routeHandler) {
    setCors(res);
    return res.status(404).json({ ok: false, error: 'API route not found', route });
  }

  return routeHandler(req, res);
};
