(() => {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduceMotion || !window.gsap || !window.ScrollTrigger) return;

  const { gsap, ScrollTrigger } = window;
  gsap.registerPlugin(ScrollTrigger);

  gsap.timeline({
    scrollTrigger: {
      trigger: '.data-flow',
      start: 'top 76%',
      end: 'bottom 40%',
      scrub: 0.7
    }
  })
    .fromTo('.route-node-one', { y: 20, rotate: -2 }, { y: 0, rotate: 0, ease: 'none' }, 0)
    .fromTo('.route-node-two', { y: 30, rotate: 2 }, { y: 0, rotate: 0, ease: 'none' }, 0.12)
    .fromTo('.route-node-three', { y: 42, rotate: -1 }, { y: 0, rotate: 0, ease: 'none' }, 0.24);

  gsap.fromTo('.reveal-word',
    { y: 7, opacity: 0.72 },
    {
      y: 0,
      opacity: 1,
      stagger: 0.08,
      ease: 'none',
      scrollTrigger: {
        trigger: '.flow-intro h2',
        start: 'top 86%',
        end: 'center 48%',
        scrub: true
      }
    }
  );
})();
