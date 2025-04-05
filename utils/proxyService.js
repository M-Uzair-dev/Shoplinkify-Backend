const axios = require("axios");
const proxyConfig = require("../config/proxy");

/**
 * Proxy service to help bypass anti-scraping measures
 * This is a placeholder implementation that you can replace with your own proxy service
 * or a third-party service like Bright Data, Oxylabs, etc.
 */
class ProxyService {
  constructor() {
    // Load configuration
    this.enabled = proxyConfig.enabled;
    this.proxyUrls = proxyConfig.urls;
    this.retryConfig = proxyConfig.retry;
    this.timeoutConfig = proxyConfig.timeout;

    this.currentProxyIndex = 0;

    console.log(
      `Proxy service initialized with ${this.proxyUrls.length} proxies, enabled: ${this.enabled}`
    );
  }

  /**
   * Get the next proxy URL in the rotation
   * @returns {string} The next proxy URL
   */
  getNextProxy() {
    if (!this.enabled || this.proxyUrls.length === 0) {
      return null;
    }

    const proxy = this.proxyUrls[this.currentProxyIndex];
    this.currentProxyIndex =
      (this.currentProxyIndex + 1) % this.proxyUrls.length;
    return proxy;
  }

  /**
   * Make a request through a proxy
   * @param {string} url - The URL to request
   * @param {Object} options - Request options
   * @returns {Promise<Object>} - The response
   */
  async request(url, options = {}) {
    const proxy = this.getNextProxy();

    if (!proxy) {
      console.log(
        "No proxy available or proxies disabled, making direct request"
      );
      return axios.request({
        url,
        ...options,
      });
    }

    console.log(`Making request through proxy: ${proxy}`);

    let retries = 0;
    let lastError = null;

    while (retries < this.retryConfig.maxRetries) {
      try {
        // Configure proxy
        const proxyConfig = {
          proxy: {
            host: new URL(proxy).hostname,
            port: new URL(proxy).port,
            auth: {
              username: new URL(proxy).username,
              password: new URL(proxy).password,
            },
          },
        };

        return await axios.request({
          url,
          ...options,
          ...proxyConfig,
          timeout: options.timeout || this.timeoutConfig.request,
        });
      } catch (error) {
        lastError = error;
        console.error(
          `Proxy request failed (attempt ${retries + 1}/${
            this.retryConfig.maxRetries
          }):`,
          error.message
        );

        // Wait before retrying
        if (retries < this.retryConfig.maxRetries - 1) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.retryConfig.delay)
          );
        }

        retries++;
      }
    }

    // If all retries failed, fall back to direct request
    console.log("All proxy attempts failed, falling back to direct request");
    try {
      return await axios.request({
        url,
        ...options,
        timeout: options.timeout || this.timeoutConfig.request,
      });
    } catch (directError) {
      console.error("Direct request also failed:", directError.message);
      throw lastError || directError;
    }
  }
}

// Create a singleton instance
const proxyService = new ProxyService();

module.exports = proxyService;
