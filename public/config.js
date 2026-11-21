// Настройки клиентской части.
// API_URL — адрес REST API.
//   "/api"  — сервер на том же домене (локально) или запросы проксируются хостингом (Netlify, см. netlify.toml).
//   Если сервер размещён на другом домене без прокси, укажите полный адрес, например:
//   "https://divesea-api.onrender.com/api"  (тогда на сервере нужны COOKIE_SAMESITE=None и CORS_ORIGIN с адресом сайта).
window.APP_CONFIG = {
  API_URL: "/api",
};
