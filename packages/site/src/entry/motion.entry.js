// Entry for assets/motion.js: gsap and ScrollTrigger come from the package (exact versions in package.json) and are
// put on window, where motion.js reads them, so the page loads no GSAP from a CDN.
import './gsap-globals.js';
import '../static/assets/motion.js';
