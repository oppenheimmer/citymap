import { mount } from 'svelte';
import App from './App.svelte';
import { fontFaceCss } from './lib/fonts.ts';
import './style.css';

// Map typefaces are declared once, from the same list SVG exports embed.
document.head.append(Object.assign(document.createElement('style'), { textContent: fontFaceCss() }));
mount(App, { target: document.getElementById('app')! });
