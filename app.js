/**
 * Passenger entry point.
 *
 * cPanel's "Setup Node.js App" runs a single startup file from the application
 * root — conventionally app.js — under Phusion Passenger. Passenger supplies
 * its own listening socket through the PORT environment variable, so all this
 * file needs to do is load the real server.
 *
 * Kept as a separate file rather than moving src/server.js here so that
 * `npm start` and Passenger take exactly the same code path.
 */

import './src/server.js';
