package com.ceastar.pms;

import java.io.File;
import org.mpxj.ProjectFile;
import org.mpxj.mspdi.MSPDIWriter;
import org.mpxj.reader.UniversalProjectReader;

public final class MppConverter {
  private MppConverter() {}

  public static void main(String[] args) {
    if (args.length != 2) {
      System.err.println("Usage: mpp-converter <input.mpp> <output.xml>");
      System.exit(2);
    }

    File input = new File(args[0]);
    File output = new File(args[1]);
    if (!input.isFile()) {
      System.err.println("Input not found: " + input.getAbsolutePath());
      System.exit(2);
    }

    try {
      ProjectFile project = new UniversalProjectReader().read(input);
      if (project == null) {
        throw new IllegalArgumentException("文件格式不受支持或文件内容无法读取");
      }
      new MSPDIWriter().write(project, output);
    } catch (Exception error) {
      System.err.println("MPP conversion failed: " + error.getClass().getSimpleName() + ": " + error.getMessage());
      System.exit(1);
    }
  }
}
