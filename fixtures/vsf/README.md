# VICE snapshot fixtures

`raster-demo.vsf` is a snapshot of `fixtures/prg/raster-demo.prg` running in x64sc 3.10. VICE stopped at a breakpoint
in its raster IRQ (`$08c7`). At that point the PC is `$08c7`, the IRQ vector `$0314` points to `$08b7`, and `$01` is
`$37`. It was made from the repository root with:

```bash
x64sc -config <a new, empty vice.ini> -default -console -sounddev dummy +confirmonexit -moncommands fixtures/vsf/make-raster-demo.mon -initbreak ready
```

It holds RAM and device state only, no ROM images. `-config` keeps VICE away from your own settings.
