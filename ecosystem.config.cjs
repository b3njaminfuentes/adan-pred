module.exports = {
  apps : [{
    name   : "ADAN-MIND",
    script : "./adan-pred.js",
    node_args: "--env-file=.env",
    env: {
      BRIER_MIN_EDGE: 0.02
    }
  }]
};
