import React from 'react';
import {registerRoot, Composition} from 'remotion';
import {ProductFilm} from './product-film.jsx';
const Root=()=> <><Composition id="AIBroZH" component={ProductFilm} durationInFrames={1260} fps={30} width={1920} height={1080} defaultProps={{lang:'zh'}}/><Composition id="AIBroEN" component={ProductFilm} durationInFrames={1260} fps={30} width={1920} height={1080} defaultProps={{lang:'en'}}/></>;
registerRoot(Root);
