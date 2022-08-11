import csv
import datetime
import glob
import json
import os.path
import re
import statistics
import sys


def main(args):
    # Find all *.csv files in the data directory, and parse out the date from
    # the filename.
    dates = []
    paths = glob.glob("public/data/*.csv")
    all_num_aircraft_hexes = {}
    all_num_bad_hexes = {}
    for path in paths:
        num_bad_hexes = 0
        filename = os.path.basename(path)
        match = re.match(r"^(\d{4}-\d{2}-\d{2}).*?.csv$", filename)
        if not match:
            continue
        date = match.group(1)
        dates.append(date)
        with open(path, "r") as f:
            num_aircraft_hexes = 0
            lines = f.readlines()[1:]
            for l in lines:
                pieces = l.split(",")
                num_good_aircraft = int(pieces[1])
                num_bad_aircraft = int(pieces[2])
                num_aircraft_hexes += num_good_aircraft + num_bad_aircraft
                if (num_bad_aircraft - 1) / (num_good_aircraft + num_bad_aircraft) >= 0.10:
                    num_bad_hexes += 1
        all_num_aircraft_hexes[date] = num_aircraft_hexes
        all_num_bad_hexes[date] = num_bad_hexes
    mean = statistics.mean(all_num_aircraft_hexes.values())
    std_dev = statistics.stdev(all_num_aircraft_hexes.values())
    print("Mean: {}".format(mean))
    print("Std Dev: {}".format(std_dev))
    print('Suspect dates:')
    for date in all_num_aircraft_hexes:
        if abs(all_num_aircraft_hexes[date] - mean) > 2 * std_dev:
            print("{}: {}".format(date, all_num_aircraft_hexes[date]))

    dates = sorted(dates)
    with open("public/data/manifest.csv", "w") as f:
        field_names = ["date", "suspect", "num_bad_aircraft_hexes"]
        writer = csv.DictWriter(f, fieldnames=field_names)
        writer.writeheader()
        for date in dates:
            writer.writerow(
                {
                    "date": date,
                    "suspect": json.dumps(abs(all_num_aircraft_hexes[date] - mean) > 2 * std_dev),
                    "num_bad_aircraft_hexes": all_num_bad_hexes[date]
                }
            )


if __name__ == "__main__":
    main(sys.argv)
