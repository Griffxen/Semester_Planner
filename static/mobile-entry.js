/* Choose a shell once. Rotation never replaces an active page or draft. */
try {
  const query = new URLSearchParams(location.search);
  if (query.has('desktop')) sessionStorage.setItem('semester-desktop', '1');
  if (query.has('mobile')) sessionStorage.removeItem('semester-desktop');
  if (matchMedia('(max-width:700px)').matches && !sessionStorage.getItem('semester-desktop')) {
    location.replace('/m/' + location.hash);
  }
} catch (error) {
  if (matchMedia('(max-width:700px)').matches && !new URLSearchParams(location.search).has('desktop')) location.replace('/m/');
}
