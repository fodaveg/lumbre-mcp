// Cortafuegos de la sonda (se carga con --import): cualquier fetch que no vaya a 127.0.0.1 se bloquea y se registra.
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
	const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
	if (url.hostname !== '127.0.0.1') {
		console.error(`NOPROD: bloqueado fetch a ${url.hostname}`);
		return Promise.reject(new TypeError('bloqueado por la sonda (no producción)'));
	}
	return real(input, init);
};
