module.exports = {
  apps : [{
    name   : "ADAN-MIND",
    script : "./adan-pred.js",
    env: {
      BRIER_MIN_EDGE: 0.02
    }
  }]
}
