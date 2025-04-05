/**
 * Proxy configuration
 *
 * This file contains configuration for the proxy service.
 * You can add your proxy URLs here or load them from environment variables.
 */

// Proxy URLs - add your proxy URLs here
// Format: 'http://username:password@proxy.example.com:8080'
const proxyUrls = [
  // Add your proxy URLs here
  // Example: process.env.PROXY_URL_1,
  // Example: process.env.PROXY_URL_2,
];

// Proxy configuration
const proxyConfig = {
  // Whether to use proxies
  enabled: process.env.USE_PROXIES === "true",

  // Proxy URLs
  urls: proxyUrls.filter((url) => url),

  // Retry configuration
  retry: {
    // Maximum number of retries
    maxRetries: 3,

    // Delay between retries in milliseconds
    delay: 1000,
  },

  // Timeout configuration
  timeout: {
    // Request timeout in milliseconds
    request: 15000,

    // Image verification timeout in milliseconds
    imageVerification: 5000,
  },
};

module.exports = proxyConfig;
