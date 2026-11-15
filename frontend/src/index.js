import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ConsentBanner from './tracking/ConsentBanner';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /><ConsentBanner /></React.StrictMode>);
