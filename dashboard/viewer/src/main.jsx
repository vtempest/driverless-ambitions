// Must come before anything that pulls in @xviz/*.
import './node-globals';

import React from 'react';
import {render} from 'react-dom';

import App from './app';
import './app.css';

render(<App />, document.getElementById('app'));
