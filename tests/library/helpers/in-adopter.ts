import { ADOPTER } from './adopter.js';

// Every library test runs in the fixture adopter, as a lane runs the library in the
// adopter's checkout. A setup file, so it holds before any test file imports a library
// module: several read the App register when they load.
process.chdir(ADOPTER);
