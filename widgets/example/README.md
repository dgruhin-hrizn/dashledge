# Build a widget package

This working example shows free memory on the Mac. Install the ZIP directly to try it.

1. Unzip the example and edit widget.json in a text editor. Set a unique ID starting with plugin., give the widget a title and description, and set its version.
2. Choose the feed. The mac feed provides CPU utilization (cpu), available memory (freeGiB), and network rates (rx and tx). For your own endpoint, use json and enter the field path, such as sensors.0.temperature. Configure the server and its credentials in the widget’s Settings after installation.
3. Choose number, trend, or list for the view. Replace icon.png with a square PNG up to 512 × 512 pixels and 64 KiB.
4. Compress widget.json and icon.png together in a ZIP. In Widget Studio, choose Install package. Use the same ID to update an installed widget and keep its placements.
